import type { ChatMsg } from '@/api/client';
import { templateSupportsNegative } from '@/backends/comfyTemplates';
import { getWorkflowPlaceholders } from '@/backends/comfyui';
import { naiSupportsCharacterPrompts } from '@/backends/nai';
import type { Orientation } from '@/backends/size';
import {
  cleanHistoryText,
  cleanHistoryTextAsync,
  prepareTargetText,
  type PreparedTargetText,
} from '@/autoTag/clean';
import {
  buildCharCardSystem,
  buildPersonaSystem,
  buildWorldInfoSystem,
  fetchCharCard,
  fetchUserPersona,
  fetchWorldInfo,
} from '@/autoTag/context';
import type { BookMemoryContext } from '@/autoTag/bookMemory';
import { compilePromptPreset } from '@/prompt/compiler';
import { buildProtocolContract } from '@/prompt/defaultBlocks';
import type { AutoTagCompileContext, CompiledChatMsg, CompileResult, PromptPreset } from '@/prompt/types';
import { isAiStoryMessage, isStoryMessage, type STContext } from '@/st/context';
import type { AutoTagSettings } from '@/state/settings';
import {
  activeComfyPreset,
  activeComfyPromptSet,
  activeNaiPlan,
  activeOrientationLock,
  activePromptPreset,
  builtinComfyPromptSet,
  DEFAULT_COMFY_NL_SPEC,
  DEFAULT_COMFY_THINKING,
  DEFAULT_NAI_SPEC,
  DEFAULT_NAI_THINKING,
  DEFAULT_NAI_V5_SPEC,
  DEFAULT_NAI_V5_THINKING,
  settings,
} from '@/state/settings';

/**
 * 本次自动 tag 的协议形态。按默认后端与其开关算**一次**,写协议(本模块)与验收/收尾
 * (runner.ts)共用同一份——两边各算各的迟早会漂:协议说只写 tag,验收却还在要 nl。
 */
export interface AutoTagProfile {
  /** NAI 4.5/V5:Base + 原生 Character Prompts(characters[])。 */
  naiCharPrompts: boolean;
  /**
   * 协议含 nl:ComfyUI 当前工作流开了「生成自然语言」,或 NAI 4.5/V5 开了「生成自然语言」。
   * 两个开关同一口径,只管 AI 写不写;已写进 tag 的 nl 照常发送。
   */
  nl: boolean;
  /** 渠道锁定的画幅方向;null = 由 AI 按后端规范的判据自选。 */
  lockedSize: Orientation | null;
  /**
   * 漫画方案(ComfyUI 当前方案 kind 为 comic):整楼分页画,协议换成 pages[] + MOSS 分镜。
   * NAI 恒为插画。tag 的类型由这里决定写进正文,不让 AI 选。
   */
  comic: boolean;
}

export function autoTagProfile(): AutoTagProfile {
  const backend = settings.defaultBackend;
  const naiCharPrompts = backend === 'nai' && naiSupportsCharacterPrompts(activeNaiPlan().model);
  // 两项都取自同一个当前方案 / 渠道:切方案即同时切走自然语言与画幅锁的口径。
  // 漫画方案不看自然语言开关(面板上也不显示它):开关藏起来却仍生效就成了改不了的暗格
  const preset = backend === 'comfyui' ? activeComfyPreset() : null;
  const nl = preset
    ? preset.kind === 'illustration' && preset.naturalLanguage
    : naiCharPrompts && activeNaiPlan().naturalLanguage;
  const lock = activeOrientationLock();
  return { naiCharPrompts, nl, lockedSize: lock === 'auto' ? null : lock, comic: preset?.kind === 'comic' };
}

/**
 * 展开自然语言条件段:{{#nl}}…{{/nl}} 只在开启自然语言时保留,{{^nl}}…{{/nl}} 只在关闭时保留
 * (写法借 Mustache 的段落语法,与 ComfyUI 规范里整段替换的 {{nl}} 宏互不相干)。
 *
 * 用在规范与思维链上,让一份文本在开关两侧各自自洽,而不必维护两份会漂的副本。
 * 不支持嵌套;配不上对的标记原样留着——写错了在请求历史里看得见,比静默吞掉好查。
 * 这两类文本都不经 ST 宏替换(substituteParams),标记不会被宿主吃掉。
 */
export function expandNlSections(text: string, nlOn: boolean): string {
  return text.replace(/\{\{([#^])nl\}\}([\s\S]*?)\{\{\/nl\}\}/g, (_match, kind: string, body: string) =>
    (kind === '#') === nlOn ? body : '',
  );
}

/**
 * 按默认后端取 tag 书写规范:
 * - comfyui → 当前方案引用的提示词(留空回落同类型内置);{{nl}} 宏按自然语言开关展开/置空,
 *   自定义内容不含宏时开启开关会把自然语言规范追加在末尾(防止开关静默失效)。
 * - nai → 4.5/V5 取 naiV5Spec、其余模型取 naiSpec(留空各自回落内置默认)。
 * - webui → 暂不附加。
 * 两个后端都先展开自然语言条件段(expandNlSections)。
 */
function backendPromptSpec(options: AutoTagSettings, nlOn: boolean, naiCharPromptsOn: boolean): string {
  if (settings.defaultBackend === 'comfyui') {
    const set = activeComfyPromptSet();
    const template = expandNlSections(set.spec.trim() || builtinComfyPromptSet(set.kind).spec, nlOn);
    const nlSpec = nlOn ? DEFAULT_COMFY_NL_SPEC : '';
    const resolved = template.includes('{{nl}}')
      ? template.replaceAll('{{nl}}', nlSpec)
      : nlSpec
        ? `${template}\n\n${nlSpec}`
        : template;
    // 宏置空后可能留下连续空行,折叠掉
    return resolved.replace(/\n{3,}/g, '\n\n').trim();
  }
  if (settings.defaultBackend === 'nai') {
    const template = naiCharPromptsOn
      ? (options.prompts?.naiV5Spec ?? '').trim() || DEFAULT_NAI_V5_SPEC
      : (options.prompts?.naiSpec ?? '').trim() || DEFAULT_NAI_SPEC;
    return expandNlSections(template, nlOn);
  }
  return '';
}

/**
 * 按默认后端取思维链,与 backendPromptSpec 一一配对。
 *
 * 拆成三份是因为思维链的槽位块要求填的每个字段,都得在同后端规范里有判据和词表:
 * V5 的规范讲的是 Base + Character Prompts,没有景别词表、没有横竖判据,也明令禁止
 * 邻接绑定——共用一份 ComfyUI 口径的思维链会让它被要求填规范从未教过的东西。
 * webui 暂无专属规范,回落 comfy 那份(该后端尚未接入)。
 */
function backendThinkingPrompt(options: AutoTagSettings, nlOn: boolean, naiCharPromptsOn: boolean): string {
  if (settings.defaultBackend === 'nai') {
    const template = naiCharPromptsOn
      ? (options.prompts?.naiV5Thinking ?? '').trim() || DEFAULT_NAI_V5_THINKING
      : (options.prompts?.naiThinking ?? '').trim() || DEFAULT_NAI_THINKING;
    return expandNlSections(template, nlOn);
  }
  if (settings.defaultBackend === 'comfyui') {
    const set = activeComfyPromptSet();
    return expandNlSections(set.thinking.trim() || builtinComfyPromptSet(set.kind).thinking, nlOn);
  }
  // webui 暂无专属规范,回落内置插画那份(该后端尚未接入)
  return expandNlSections(DEFAULT_COMFY_THINKING, nlOn);
}

function recentFloors(context: STContext, targetFloor: number, count: number): number[] {
  const aiFloors: number[] = [];
  for (let floor = 0; floor <= targetFloor; floor += 1) {
    const message = context.chat[floor];
    if (isAiStoryMessage(message)) aiFloors.push(floor);
  }
  const keep = Math.max(1, Math.floor(count) || 1);
  const start = aiFloors[Math.max(0, aiFloors.length - keep)] ?? targetFloor;
  const floors: number[] = [];
  for (let floor = start; floor <= targetFloor; floor += 1) {
    if (isStoryMessage(context.chat[floor])) floors.push(floor);
  }
  return floors;
}

/**
 * 生成供酒馆助手预设模式激活世界书关键词用的扫描消息数组(由旧到新)。
 * 只含清洗后的精选剧情楼层,不含生图规范或 JSON 协议,避免误触发无关世界书词条;
 * 并在 CHAT_COMPLETION_PROMPT_READY 阶段连同 marker 一并从 chatHistory 位置清掉。
 */
export function buildPresetWorldInfoScanPrompts(
  context: STContext,
  targetFloor: number,
  count: number,
): ChatMsg[] {
  const result: ChatMsg[] = [];
  for (const floor of recentFloors(context, targetFloor, count)) {
    const msg = context.chat[floor];
    const content = cleanHistoryText(msg.mes, settings.excludes.customStripTags).trim();
    if (!content) continue;
    result.push({
      role: msg.is_user ? 'user' : 'assistant',
      content,
    });
  }
  return result;
}

function roleLabel(context: STContext, floor: number): string {
  const message = context.chat[floor];
  if (message.is_user) return `user（${message.name || context.name1 || 'User'}）`;
  return `assistant（${message.name || context.name2 || 'Assistant'}）`;
}

export async function buildAutoTagCompileContext(
  context: STContext,
  targetFloor: number,
  options: AutoTagSettings,
  memory: BookMemoryContext | null,
  preparedTargetOverride?: PreparedTargetText,
  library?: string | null,
  taskNote?: string,
  profile: AutoTagProfile = autoTagProfile(),
  structuredToolMode = false,
): Promise<AutoTagCompileContext> {
  const target = context.chat[targetFloor];
  const preparedTarget =
    preparedTargetOverride
    ?? prepareTargetText(target.mes, settings.excludes.customStripTags);

  const prevFloors = recentFloors(context, targetFloor, options.contextMessages).filter(
    floor => floor !== targetFloor,
  );
  const prevCleaned = await Promise.all(
    prevFloors.map(async floor => ({
      floor,
      role: (context.chat[floor]?.is_user ? 'user' : 'assistant') as 'user' | 'assistant',
      label: roleLabel(context, floor),
      cleaned: await cleanHistoryTextAsync(
        context.chat[floor].mes,
        settings.excludes.customStripTags,
        settings.cleanRegexRules,
      ),
    })),
  );
  const previous = prevCleaned
    .map(item => `--- 上下文｜${item.label} ---\n${item.cleaned}`)
    .join('\n\n');
  const historyTurns = prevCleaned
    .filter(item => item.cleaned.trim())
    .map(item => ({ role: item.role, content: item.cleaned }));

  const memoryText = memory ? memory.text : '角色参考：柏宝书本次未提供。';
  const scanFloors = recentFloors(context, targetFloor, options.contextMessages);
  const [rawWorldInfo, rawCharCard, rawPersona] = await Promise.all([
    fetchWorldInfo(context.chat, scanFloors, context.name1, context.name2),
    Promise.resolve(fetchCharCard(context)),
    Promise.resolve(fetchUserPersona(context)),
  ]);

  const comfyOn = settings.defaultBackend === 'comfyui';
  const naiCharPromptsOn = profile.naiCharPrompts;
  const comfyPreset = comfyOn ? activeComfyPreset() : null;
  const nlOn = profile.nl;

  let negativeOn = false;
  if (comfyPreset) {
    if (comfyPreset.mode === 'simple') {
      negativeOn = templateSupportsNegative(comfyPreset.simple.template);
    } else if (comfyPreset.workflow.trim()) {
      try {
        negativeOn = getWorkflowPlaceholders(comfyPreset.workflow).includes('negative_prompt');
      } catch {
        // 工作流无效时降级为不请求动态负面词
      }
    }
  }

  const maxImages = Math.max(1, Math.floor(Number(options.maxImages)) || 1);
  const minImages = Math.min(maxImages, Math.max(0, Math.floor(Number(options.minImages)) || 0));

  const backendSpec = backendPromptSpec(options, nlOn, naiCharPromptsOn);
  const protocolContract = buildProtocolContract({
    profile,
    minImages,
    maxImages,
    negativeOn,
    hasLibrary: Boolean(library?.trim()),
    structuredToolMode,
  });
  const thinkingGuide = backendThinkingPrompt(options, nlOn, naiCharPromptsOn);
  const libraryBlock =
    library?.trim()
    || '【角色固定外貌库】[system-maintained; currently empty]\n（当前为空，没有任何角色已建档。世界书、角色卡、柏宝书和正文只提供建档依据；未列在本区块中的正式角色必须通过 field:"new" 建档。）';

  return {
    backend: settings.defaultBackend,
    profile,
    minImages,
    maxImages,
    negativeOn,
    charCard: rawCharCard ? buildCharCardSystem(rawCharCard) : '',
    persona: rawPersona ? buildPersonaSystem(rawPersona) : '',
    worldInfo: rawWorldInfo ? buildWorldInfoSystem(rawWorldInfo) : '',
    bookMemory: memoryText,
    charLibrary: libraryBlock,
    slotTaskNote: taskNote?.trim() ?? '',
    historyBlock: previous,
    historyTurns,
    targetLabel: `--- 目标正文｜${roleLabel(context, targetFloor)} ---`,
    targetText: preparedTarget.promptText,
    backendSpec,
    protocolContract,
    thinkingGuide,
    charName: context.name2 || 'Char',
    userName: context.name1 || 'User',
    floor: targetFloor,
  };
}

export async function compileAutoTagPrompt(
  context: STContext,
  targetFloor: number,
  options: AutoTagSettings,
  memory: BookMemoryContext | null,
  preparedTargetOverride?: PreparedTargetText,
  library?: string | null,
  taskNote?: string,
  profile: AutoTagProfile = autoTagProfile(),
  presetOverride?: PromptPreset,
): Promise<{ compile: CompileResult; preset: PromptPreset; compileContext: AutoTagCompileContext }> {
  const basePreset = presetOverride ?? activePromptPreset();
  const customJailbreak = (options.prompts?.jailbreak ?? '').trim();
  const effectivePreset: PromptPreset =
    basePreset.builtin && customJailbreak
      ? {
          ...basePreset,
          entries: basePreset.entries.map(e =>
            e.id === 'entry_jailbreak' ? { ...e, content: customJailbreak } : e,
          ),
        }
      : basePreset;

  const compileContext = await buildAutoTagCompileContext(
    context,
    targetFloor,
    options,
    memory,
    preparedTargetOverride,
    library,
    taskNote,
    profile,
    effectivePreset.outputMode === 'tool_structured',
  );
  const compile = compilePromptPreset(effectivePreset, compileContext);
  return { compile, preset: effectivePreset, compileContext };
}

export async function buildAutoTagMessages(
  context: STContext,
  targetFloor: number,
  options: AutoTagSettings,
  memory: BookMemoryContext | null,
  preparedTargetOverride?: PreparedTargetText,
  library?: string | null,
  taskNote?: string,
  profile: AutoTagProfile = autoTagProfile(),
  presetOverride?: PromptPreset,
): Promise<CompiledChatMsg[]> {
  const { compile } = await compileAutoTagPrompt(
    context,
    targetFloor,
    options,
    memory,
    preparedTargetOverride,
    library,
    taskNote,
    profile,
    presetOverride,
  );
  return compile.messages;
}
