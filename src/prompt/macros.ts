import { DEFAULT_COMFY_NL_SPEC } from './defaultBlocks';
import type { AutoTagCompileContext, PromptSlotKind } from './types';

interface StVarContextLike {
  variables?: {
    global?: Record<string, unknown>;
    [k: string]: unknown;
  };
  chatMetadata?: {
    variables?: Record<string, unknown>;
  };
  extensionSettings?: {
    variables?: {
      global?: Record<string, unknown>;
    };
  };
}

function tryReadStVar(name: string, globalVar: boolean): string {
  try {
    const st = (globalThis as { SillyTavern?: { getContext?: () => StVarContextLike } }).SillyTavern;
    const ctx = st?.getContext?.();
    if (!ctx) return '';
    if (globalVar) {
      const val =
        ctx.extensionSettings?.variables?.global?.[name]
        ?? ctx.variables?.global?.[name];
      return val === undefined || val === null ? '' : String(val);
    }
    const localVal =
      ctx.chatMetadata?.variables?.[name]
      ?? ctx.variables?.[name];
    return localVal === undefined || localVal === null ? '' : String(localVal);
  } catch {
    return '';
  }
}

/**
 * 剥离预设中的注释（如双斜杠块注释与星号块注释）。
 */
export function stripPresetComments(text: string): string {
  return stripAllComments(text);
}

// 剥离 `{{// ...}}` 与 `//* ... *//`
function stripAllComments(text: string): string {
  if (!text) return '';
  return text
    .replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
    .replace(/\/\/\*[\s\S]*?\*\/\//g, '')
    .replace(/\/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 处理提示词模板中的 NL 条件块和占位符：
 * - `{{#nl}}...{{/nl}}`：仅 `nlOn` 为 true 时保留
 * - `{{^nl}}...{{/nl}}`：仅 `nlOn` 为 false 时保留
 * - `{{nl}}`：展开为 `DEFAULT_COMFY_NL_SPEC` 或空串
 */
export function expandNlSections(text: string, nlOn: boolean): string {
  let out = text
    .replace(/\{\{#nl\}\}([\s\S]*?)\{\{\/nl\}\}/g, (_, body: string) => (nlOn ? body : ''))
    .replace(/\{\{\^nl\}\}([\s\S]*?)\{\{\/nl\}\}/g, (_, body: string) => (nlOn ? '' : body))
    .replace(/\{\{nl\}\}/g, nlOn ? DEFAULT_COMFY_NL_SPEC : '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * 读取编译上下文中某个槽位的原始字符串值（不含宏模板包装）。
 */
export function getSlotRawValue(slotKind: PromptSlotKind, ctx: AutoTagCompileContext): string {
  switch (slotKind) {
    case 'char_card':
      return ctx.charCard;
    case 'persona':
      return ctx.persona;
    case 'world_info':
      return ctx.worldInfo;
    case 'book_memory':
      return ctx.bookMemory;
    case 'char_library':
      return ctx.charLibrary;
    case 'slot_task':
      return ctx.slotTaskNote;
    case 'history':
      return ctx.historyBlock;
    case 'target_text':
      return ctx.targetText;
    case 'backend_spec':
      return ctx.backendSpec;
    case 'protocol_contract':
      return ctx.protocolContract;
    case 'thinking_guide':
      return ctx.thinkingGuide;
  }
}

function rollDice(rawArg: string): string {
  const max = Math.floor(Number(rawArg.trim()));
  if (!Number.isFinite(max) || max < 1) return '1';
  return String(Math.floor(Math.random() * max) + 1);
}

/**
 * 展开单条提示词内容中的注释、NL 条件块、槽位占位符、标量宏、骰子与只读酒馆变量。
 *
 * 采用单遍正则替换：正文/世界书/角色卡等注入内容不会再被当作宏二次解析，避免剧情文本中的 `{{...}}` 被误执行。
 */
export function expandMacros(template: string, ctx: AutoTagCompileContext): string {
  const withoutComments = stripAllComments(template);
  const nlExpanded = expandNlSections(withoutComments, ctx.profile.nl);

  const slotMap: Record<string, string> = {
    char_card: ctx.charCard,
    角色卡: ctx.charCard,
    persona: ctx.persona,
    人设: ctx.persona,
    world_info: ctx.worldInfo,
    世界书: ctx.worldInfo,
    世界书触发: ctx.worldInfo,
    book_memory: ctx.bookMemory,
    柏宝书记忆: ctx.bookMemory,
    char_library: ctx.charLibrary,
    角色dna库: ctx.charLibrary,
    角色启用列表: ctx.charLibrary,
    slot_task: ctx.slotTaskNote,
    单槽重写任务: ctx.slotTaskNote,
    history: ctx.historyBlock,
    上下文: ctx.historyBlock,
    target_text: ctx.targetText,
    正文: ctx.targetText,
    target_label: ctx.targetLabel,
    backend_spec: expandNlSections(stripAllComments(ctx.backendSpec), ctx.profile.nl),
    后端规范: expandNlSections(stripAllComments(ctx.backendSpec), ctx.profile.nl),
    protocol_contract: ctx.protocolContract,
    输出协议: ctx.protocolContract,
    thinking_guide: expandNlSections(stripAllComments(ctx.thinkingGuide), ctx.profile.nl),
    思维链: expandNlSections(stripAllComments(ctx.thinkingGuide), ctx.profile.nl),
  };

  const scalarMap: Record<string, string> = {
    min_images: String(ctx.minImages),
    max_images: String(ctx.maxImages),
    locked_size: ctx.profile.lockedSize ?? '',
    backend: ctx.backend,
    char: ctx.charName,
    user: ctx.userName,
    floor: String(ctx.floor),
  };

  return nlExpanded
    .replace(/\{\{([^{}]+)\}\}/g, (full, rawInner: string) => {
      const inner = rawInner.trim();
      const lower = inner.toLowerCase();

      if (lower in slotMap) return slotMap[lower] ?? '';
      if (inner in slotMap) return slotMap[inner] ?? '';
      if (lower in scalarMap) return scalarMap[lower] ?? '';

      const rollMatch = /^roll(?:\s+|::?:?)(.+)$/i.exec(inner);
      if (rollMatch) {
        return rollDice(rollMatch[1]);
      }

      const globalVarMatch = /^getglobalvar::(.+)$/i.exec(inner);
      if (globalVarMatch) {
        const varName = globalVarMatch[1].trim();
        return ctx.readGlobalVar ? ctx.readGlobalVar(varName) : tryReadStVar(varName, true);
      }

      const localVarMatch = /^getvar::(.+)$/i.exec(inner);
      if (localVarMatch) {
        const varName = localVarMatch[1].trim();
        return ctx.readVar ? ctx.readVar(varName) : tryReadStVar(varName, false);
      }

      return full;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
