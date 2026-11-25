import { defaultToolCallConfig } from '@/llm/toolCallTransform';
import { DEFAULT_JAILBREAK_PROMPT } from './defaultBlocks';
import type { PromptEntry, PromptPreset } from './types';

function createCoreSlotEntries(): PromptEntry[] {
  return [
    {
      id: 'slot_char_card',
      name: '角色卡设定',
      enabled: true,
      role: 'system',
      entryType: 'slot',
      slotKind: 'char_card',
      content: '{{char_card}}',
      conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
      trigger: { mode: 'always', orWords: [], andWords: [] },
    },
    {
      id: 'slot_persona',
      name: '用户人设',
      enabled: true,
      role: 'system',
      entryType: 'slot',
      slotKind: 'persona',
      content: '{{persona}}',
      conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
      trigger: { mode: 'always', orWords: [], andWords: [] },
    },
    {
      id: 'slot_world_info',
      name: '世界书参考',
      enabled: true,
      role: 'system',
      entryType: 'slot',
      slotKind: 'world_info',
      content: '{{world_info}}',
      conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
      trigger: { mode: 'always', orWords: [], andWords: [] },
    },
    {
      id: 'slot_backend_spec',
      name: '后端画风与 Tag 规范',
      enabled: true,
      role: 'system',
      entryType: 'slot',
      slotKind: 'backend_spec',
      content: '{{backend_spec}}',
      conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
      trigger: { mode: 'always', orWords: [], andWords: [] },
    },
    {
      id: 'slot_protocol_contract',
      name: '输出格式协议',
      enabled: true,
      role: 'system',
      entryType: 'slot',
      slotKind: 'protocol_contract',
      content: '{{protocol_contract}}',
      conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
      trigger: { mode: 'always', orWords: [], andWords: [] },
    },
    {
      id: 'slot_thinking_guide',
      name: '思维链分析引导',
      enabled: true,
      role: 'system',
      entryType: 'slot',
      slotKind: 'thinking_guide',
      content: '{{thinking_guide}}',
      conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
      trigger: { mode: 'always', orWords: [], andWords: [] },
    },
    {
      id: 'slot_book_memory',
      name: '柏宝书记忆（摘要/伏笔）',
      enabled: true,
      role: 'user',
      entryType: 'slot',
      slotKind: 'book_memory',
      content: '{{book_memory}}',
      conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
      trigger: { mode: 'always', orWords: [], andWords: [] },
    },
    {
      id: 'slot_char_library',
      name: '角色 DNA 库',
      enabled: true,
      role: 'user',
      entryType: 'slot',
      slotKind: 'char_library',
      content: '{{char_library}}',
      conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
      trigger: { mode: 'always', orWords: [], andWords: [] },
    },
    {
      id: 'slot_task_note',
      name: '单槽重写任务说明',
      enabled: true,
      role: 'user',
      entryType: 'slot',
      slotKind: 'slot_task',
      content: '{{slot_task}}',
      conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'only' },
      trigger: { mode: 'always', orWords: [], andWords: [] },
    },
    {
      id: 'slot_history',
      name: '前文上下文',
      enabled: true,
      role: 'user',
      entryType: 'slot',
      slotKind: 'history',
      historyMode: 'block',
      content: '{{history}}',
      conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
      trigger: { mode: 'always', orWords: [], andWords: [] },
    },
    {
      id: 'slot_target_text',
      name: '待生图正文',
      enabled: true,
      role: 'user',
      entryType: 'slot',
      slotKind: 'target_text',
      content: '{{target_label}}\n{{target_text}}',
      conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
      trigger: { mode: 'always', orWords: [], andWords: [] },
    },
  ];
}

function jailbreakEntry(): PromptEntry {
  return {
    id: 'entry_jailbreak',
    name: '核心系统与创作边界',
    enabled: true,
    role: 'system',
    entryType: 'normal',
    content: DEFAULT_JAILBREAK_PROMPT,
    conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
    trigger: { mode: 'always', orWords: [], andWords: [] },
  };
}

export const BUILTIN_PROMPT_PRESETS: PromptPreset[] = [
  {
    id: 'builtin_text_json',
    name: '默认（文本 JSON 协议）',
    builtin: true,
    scope: 'universal',
    outputMode: 'text_json',
    mergeAdjacentSameRole: false,
    mergeSystemIntoUser: false,
    toolCall: defaultToolCallConfig(),
    entries: [
      jailbreakEntry(),
      ...createCoreSlotEntries().slice(0, 6),
      {
        id: 'entry_user_material',
        name: '绘图参考材料（聚合）',
        enabled: true,
        role: 'user',
        entryType: 'normal',
        content: '{{book_memory}}\n\n{{char_library}}\n\n{{slot_task}}\n\n{{history}}\n\n{{target_label}}\n{{target_text}}',
        conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
        trigger: { mode: 'always', orWords: [], andWords: [] },
      },
    ],
  },
  {
    id: 'builtin_tool_tunnel',
    name: 'Tool Calls 隧道（标准 Mode B）',
    builtin: true,
    scope: 'universal',
    outputMode: 'tool_tunnel',
    mergeAdjacentSameRole: true,
    mergeSystemIntoUser: false,
    toolCall: {
      ...defaultToolCallConfig(),
      guideWrap: false,
    },
    entries: [
      jailbreakEntry(),
      ...createCoreSlotEntries(),
      {
        id: 'entry_tool_guide_b',
        name: '【ToolCall引导】工具调用指令',
        enabled: true,
        role: 'user',
        entryType: 'tool_guide',
        content: '请立即调用已声明的插画计划记录工具，将完整思考写入 thoughts 参数、严格符合 JSON 协议的结果写入 output 参数。不要直接在对话正文输出 JSON。',
        conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
        trigger: { mode: 'always', orWords: [], andWords: [] },
      },
    ],
  },
  {
    id: 'builtin_tool_guide',
    name: 'Tool Calls 强伪装隧道（智绘姬风格 Mode A）',
    builtin: true,
    scope: 'universal',
    outputMode: 'tool_tunnel',
    mergeAdjacentSameRole: true,
    mergeSystemIntoUser: false,
    toolCall: {
      ...defaultToolCallConfig(),
      guideWrap: true,
      toolChoice: 'required',
    },
    entries: [
      jailbreakEntry(),
      ...createCoreSlotEntries(),
      {
        id: 'entry_tool_guide_a',
        name: '【ToolCall引导】伪装执行指令',
        enabled: true,
        role: 'user',
        entryType: 'tool_guide',
        content: '请阅读工具定义中的【任务档案与参考上下文】，严格依据其中规范与待生图正文生成分镜方案，并通过调用该工具提交 thoughts（分析）与 output（完整 JSON 字符串）。',
        conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
        trigger: { mode: 'always', orWords: [], andWords: [] },
      },
    ],
  },
  {
    id: 'builtin_tool_structured',
    name: '结构化 Schema Tool（原生 Function Calling）',
    builtin: true,
    scope: 'universal',
    outputMode: 'tool_structured',
    mergeAdjacentSameRole: true,
    mergeSystemIntoUser: false,
    toolCall: {
      ...defaultToolCallConfig(),
      guideWrap: false,
      toolChoice: 'auto',
    },
    entries: [
      jailbreakEntry(),
      ...createCoreSlotEntries(),
      {
        id: 'entry_tool_guide_structured',
        name: '结构化函数提交指引',
        enabled: true,
        role: 'user',
        entryType: 'normal',
        content: '请先在思维链中完成构思，然后调用结构化函数工具直接提交生图方案与人物外貌档案更新（若上游不支持函数调用，则按协议直接输出 <thinking> 与 JSON）。',
        conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
        trigger: { mode: 'always', orWords: [], andWords: [] },
      },
    ],
  },
];

export function clonePromptPreset(preset: PromptPreset, newName?: string): PromptPreset {
  const cloned = JSON.parse(JSON.stringify(preset)) as PromptPreset;
  cloned.builtin = false;
  if (newName !== undefined) {
    cloned.name = newName;
  }
  return cloned;
}

export function resolvePromptPreset(id: string | undefined, customPresets: PromptPreset[]): PromptPreset {
  const wanted = (id ?? '').trim();
  if (wanted) {
    const custom = customPresets.find(p => p.id === wanted);
    if (custom) return custom;
    const builtin = BUILTIN_PROMPT_PRESETS.find(p => p.id === wanted);
    if (builtin) return builtin;
  }
  return customPresets[0] ?? BUILTIN_PROMPT_PRESETS[0];
}

export function allPromptPresets(customPresets: PromptPreset[]): PromptPreset[] {
  return [...BUILTIN_PROMPT_PRESETS, ...customPresets];
}
