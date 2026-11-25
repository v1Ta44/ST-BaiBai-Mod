import { defaultToolCallConfig } from '@/llm/toolCallTransform';
import type { ToolTunnelField } from '@/llm/types';
import type { PromptEntry, PromptEntryRole, PromptPreset, PromptSlotKind } from './types';

function mkId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function asRole(v: unknown): PromptEntryRole {
  if (v === 'system' || v === 'user' || v === 'assistant') return v;
  return 'system';
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(x => String(x ?? '').trim()).filter(Boolean);
  }
  if (typeof v === 'string') {
    return v
      .split(/[\n,，|]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }
  return [];
}

const CHATU8_MACRO_MAP: Array<[RegExp, string, PromptSlotKind?]> = [
  [/\{\{上下文\}\}/g, '{{history}}', 'history'],
  [/\{\{世界书触发\}\}/g, '{{world_info}}', 'world_info'],
  [/\{\{世界书\}\}/g, '{{world_info}}', 'world_info'],
  [/\{\{正文\}\}/g, '{{target_text}}', 'target_text'],
  [/\{\{角色启用列表\}\}/g, '{{char_library}}', 'char_library'],
  [/\{\{角色DNA库\}\}/g, '{{char_library}}', 'char_library'],
  [/\{\{角色卡\}\}/g, '{{char_card}}', 'char_card'],
  [/\{\{人设\}\}/g, '{{persona}}', 'persona'],
  [/\{\{柏宝书记忆\}\}/g, '{{book_memory}}', 'book_memory'],
  [/\{\{输出协议\}\}/g, '{{protocol_contract}}', 'protocol_contract'],
  [/\{\{后端规范\}\}/g, '{{backend_spec}}', 'backend_spec'],
  [/\{\{思维链\}\}/g, '{{thinking_guide}}', 'thinking_guide'],
];

const PURE_SLOT_MAP: Record<string, PromptSlotKind> = {
  '{{char_card}}': 'char_card',
  '{{persona}}': 'persona',
  '{{world_info}}': 'world_info',
  '{{book_memory}}': 'book_memory',
  '{{char_library}}': 'char_library',
  '{{slot_task}}': 'slot_task',
  '{{history}}': 'history',
  '{{target_text}}': 'target_text',
  '{{backend_spec}}': 'backend_spec',
  '{{protocol_contract}}': 'protocol_contract',
  '{{thinking_guide}}': 'thinking_guide',
};

function translateChatu8Content(raw: string): { content: string; inferredSlot?: PromptSlotKind } {
  let content = raw;
  for (const [re, replacement] of CHATU8_MACRO_MAP) {
    content = content.replace(re, replacement);
  }
  const trimmed = content.trim();
  const inferredSlot = PURE_SLOT_MAP[trimmed];
  return { content, inferredSlot };
}

function normalizeImportedEntry(raw: Record<string, unknown>, idx: number): {
  entry: PromptEntry;
  detectedGuide: boolean;
} {
  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim()
    : `导入条目 ${idx + 1}`;
  const rawRole = typeof raw.role === 'string' ? raw.role : 'system';
  const rawType = typeof raw.entryType === 'string' ? raw.entryType : '';
  const isGuide =
    rawType === 'tool_guide'
    || rawRole === 'tool_guide'
    || name.includes('【ToolCall引导】')
    || name.includes('ToolCall引导');

  const rawContent = typeof raw.content === 'string' ? raw.content : '';
  const { content, inferredSlot } = translateChatu8Content(rawContent);

  let entryType: PromptEntry['entryType'] = isGuide ? 'tool_guide' : 'normal';
  let slotKind: PromptSlotKind | undefined;
  if (!isGuide) {
    if (rawType === 'slot' && typeof raw.slotKind === 'string' && raw.slotKind in PURE_SLOT_MAP) {
      entryType = 'slot';
      slotKind = raw.slotKind as PromptSlotKind;
    } else if (typeof raw.slotKind === 'string' && (`{{${raw.slotKind}}}` in PURE_SLOT_MAP)) {
      entryType = 'slot';
      slotKind = raw.slotKind as PromptSlotKind;
    } else if (inferredSlot) {
      entryType = 'slot';
      slotKind = inferredSlot;
    }
  }

  const trigModeRaw =
    (raw.trigger as Record<string, unknown> | undefined)?.mode
    ?? raw.triggerMode
    ?? 'always';
  const orWords = asStringArray(
    (raw.trigger as Record<string, unknown> | undefined)?.orWords
    ?? raw.triggerWords,
  );
  const andWords = asStringArray(
    (raw.trigger as Record<string, unknown> | undefined)?.andWords
    ?? raw.andTriggerWords,
  );

  const entry: PromptEntry = {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : mkId('imp_e'),
    name,
    enabled: raw.enabled !== false,
    role: isGuide ? (rawRole === 'system' || rawRole === 'assistant' ? rawRole : 'user') : asRole(rawRole),
    entryType,
    ...(slotKind ? { slotKind } : {}),
    ...(raw.historyMode === 'turns' || raw.historyMode === 'block' ? { historyMode: raw.historyMode } : {}),
    content,
    conditions: {
      nl: (raw.conditions as Record<string, unknown> | undefined)?.nl === 'on'
        ? 'on'
        : (raw.conditions as Record<string, unknown> | undefined)?.nl === 'off'
          ? 'off'
          : 'any',
      comic: (raw.conditions as Record<string, unknown> | undefined)?.comic === 'on'
        ? 'on'
        : (raw.conditions as Record<string, unknown> | undefined)?.comic === 'off'
          ? 'off'
          : 'any',
      backend:
        (raw.conditions as Record<string, unknown> | undefined)?.backend === 'nai'
        || (raw.conditions as Record<string, unknown> | undefined)?.backend === 'comfyui'
          ? ((raw.conditions as Record<string, unknown>).backend as 'nai' | 'comfyui')
          : 'any',
      slotRewrite:
        (raw.conditions as Record<string, unknown> | undefined)?.slotRewrite === 'only'
        || (raw.conditions as Record<string, unknown> | undefined)?.slotRewrite === 'exclude'
          ? ((raw.conditions as Record<string, unknown>).slotRewrite as 'only' | 'exclude')
          : 'any',
    },
    trigger: {
      mode: trigModeRaw === 'keyword' ? 'keyword' : 'always',
      orWords,
      andWords,
    },
  };

  return { entry, detectedGuide: isGuide };
}

function normalizeImportedPresetObject(raw: Record<string, unknown>, idx: number): PromptPreset {
  const baseToolCall = defaultToolCallConfig();
  const rawToolCall = (raw.toolCall ?? raw.toolCallConfig ?? {}) as Record<string, unknown>;
  const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];

  let anyGuide = false;
  const entries: PromptEntry[] = rawEntries
    .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
    .map((x, eIdx) => {
      const res = normalizeImportedEntry(x, eIdx);
      if (res.detectedGuide) anyGuide = true;
      return res.entry;
    });

  const rawMode = raw.outputMode;
  const outputMode: PromptPreset['outputMode'] =
    rawMode === 'text_json' || rawMode === 'tool_tunnel' || rawMode === 'tool_structured'
      ? rawMode
      : anyGuide || rawToolCall.enabled === true
        ? 'tool_tunnel'
        : 'text_json';

  const rawFields = Array.isArray(rawToolCall.fields) ? rawToolCall.fields : [];
  const fields: ToolTunnelField[] =
    rawFields.length > 0
      ? rawFields
          .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === 'object'))
          .map(f => ({
            name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : 'output',
            description: typeof f.description === 'string' ? f.description : '',
            required: f.required !== false,
            ...(typeof f.wrapTag === 'string' && f.wrapTag.trim() ? { wrapTag: f.wrapTag.trim() } : {}),
          }))
      : baseToolCall.fields;

  const toolChoice =
    rawToolCall.toolChoice === 'auto'
    || rawToolCall.toolChoice === 'required'
    || rawToolCall.toolChoice === 'function'
      ? rawToolCall.toolChoice
      : baseToolCall.toolChoice;

  return {
    id: mkId(`preset_${idx + 1}`),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `导入预设 ${idx + 1}`,
    builtin: false,
    scope:
      raw.scope === 'nai' || raw.scope === 'comfy-illust' || raw.scope === 'comfy-comic'
        ? raw.scope
        : 'universal',
    outputMode,
    mergeAdjacentSameRole: raw.mergeAdjacentSameRole !== false,
    mergeSystemIntoUser: Boolean(raw.mergeSystemIntoUser),
    toolCall: {
      ...baseToolCall,
      nameMode: rawToolCall.nameMode === 'fixed' ? 'fixed' : 'dynamic',
      prefix: typeof rawToolCall.prefix === 'string' && rawToolCall.prefix.trim() ? rawToolCall.prefix : baseToolCall.prefix,
      fixedName: typeof rawToolCall.fixedName === 'string' && rawToolCall.fixedName.trim()
        ? rawToolCall.fixedName
        : baseToolCall.fixedName,
      toolChoice,
      description: typeof rawToolCall.description === 'string' ? rawToolCall.description : baseToolCall.description,
      fields,
      guideWrap: typeof rawToolCall.guideWrap === 'boolean' ? rawToolCall.guideWrap : anyGuide,
      guideArchiveHeader: typeof rawToolCall.guideArchiveHeader === 'string'
        ? rawToolCall.guideArchiveHeader
        : baseToolCall.guideArchiveHeader,
      guideFieldName: typeof rawToolCall.guideFieldName === 'string' && rawToolCall.guideFieldName.trim()
        ? rawToolCall.guideFieldName
        : baseToolCall.guideFieldName,
      guideFieldDesc: typeof rawToolCall.guideFieldDesc === 'string'
        ? rawToolCall.guideFieldDesc
        : baseToolCall.guideFieldDesc,
      enableTailMessages: Boolean(rawToolCall.enableTailMessages),
      tailMessages: Array.isArray(rawToolCall.tailMessages)
        ? rawToolCall.tailMessages
            .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object'))
            .map((t, tIdx) => ({
              id: typeof t.id === 'string' ? t.id : mkId(`tail_${tIdx}`),
              enabled: t.enabled !== false,
              role: asRole(t.role),
              content: typeof t.content === 'string' ? t.content : '',
            }))
        : [],
    },
    entries,
  };
}

/**
 * 脱敏导出单条提示词预设 JSON（仅含提示词模板与 ToolCall 规则，绝不含任何 API Key/URL）。
 */
export function exportPromptPresetJson(preset: PromptPreset): string {
  const clean: PromptPreset = {
    id: preset.id,
    name: preset.name,
    scope: preset.scope,
    outputMode: preset.outputMode,
    mergeAdjacentSameRole: preset.mergeAdjacentSameRole,
    mergeSystemIntoUser: preset.mergeSystemIntoUser,
    toolCall: JSON.parse(JSON.stringify(preset.toolCall)),
    entries: JSON.parse(JSON.stringify(preset.entries)),
  };
  return JSON.stringify(
    {
      format: 'st-baibai-mod-prompt-v1',
      exportedAt: new Date().toISOString(),
      preset: clean,
    },
    null,
    2,
  );
}

/**
 * 导入提示词预设 JSON，兼容：
 * - 本插件 `st-baibai-mod-prompt-v1` 单个或数组
 * - 智绘姬 `test_context_profiles`（单配置、数组、或 `{ test_context_profiles: [...] }` / `{ profiles: [...] }`）
 * - 纯条目数组（打包为一个新预设）
 */
export function importPromptPresetJson(rawJson: string): PromptPreset[] {
  const parsed = JSON.parse(rawJson) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON 根结构无效：需要对象或数组');
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) throw new Error('导入列表为空');
    const first = parsed[0] as Record<string, unknown>;
    if (first && typeof first === 'object' && Array.isArray(first.entries)) {
      return parsed
        .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
        .map((x, idx) => normalizeImportedPresetObject(x, idx));
    }
    return [normalizeImportedPresetObject({ name: '导入的条目集', entries: parsed }, 0)];
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.preset && typeof obj.preset === 'object') {
    return [normalizeImportedPresetObject(obj.preset as Record<string, unknown>, 0)];
  }

  const listCandidate =
    (Array.isArray(obj.presets) ? obj.presets : null)
    ?? (Array.isArray(obj.test_context_profiles) ? obj.test_context_profiles : null)
    ?? (Array.isArray(obj.profiles) ? obj.profiles : null);
  if (listCandidate) {
    if (listCandidate.length === 0) throw new Error('配置文件中没有可导入的预设');
    return listCandidate
      .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
      .map((x, idx) => normalizeImportedPresetObject(x, idx));
  }

  if (Array.isArray(obj.entries)) {
    return [normalizeImportedPresetObject(obj, 0)];
  }

  throw new Error('无法识别的预设 JSON 格式（未找到 preset / entries / test_context_profiles）');
}
