import type { ChatMsg, ChatMsgContentPart, OpenAiToolDef, ToolChoice } from '@/api/client';
import type { AutoTagProfile } from '@/autoTag/prompt';
import type {
  ToolCallPresetConfig,
  ToolTunnelField,
  ToolTunnelTransformResult,
} from '@/llm/types';

export function defaultToolCallConfig(overrides: Partial<ToolCallPresetConfig> = {}): ToolCallPresetConfig {
  return {
    nameMode: 'dynamic',
    prefix: 'agw_emit_',
    fixedName: 'emit_illustration_plan',
    toolChoice: 'auto',
    description:
      '提交本轮剧情的视觉分镜规划与角色外貌变更。请严格按照系统规范完成思考与 JSON 组织，并通过该工具参数完整输出。',
    fields: [
      {
        name: 'thought_and_payload',
        description:
          '先输出 <thinking>...</thinking> 检查清单，闭合后紧跟唯一一个合法 JSON 对象（不要使用 Markdown 代码块）。',
        required: true,
        wrapTag: '',
      },
    ],
    guideWrap: false,
    guideArchiveHeader: '【/workspace/archive/ 本地工作目录文件与业务规约】：',
    guideFieldName: 'display_stream',
    guideFieldDesc:
      '写入格式化 UTF-8 输出流：先以 <thinking>...</thinking> 简要核对，闭合后紧跟唯一一个合法 JSON 对象。',
    enableTailMessages: false,
    tailMessages: [
      {
        id: 'tail_route_1',
        enabled: true,
        role: 'user',
        content:
          '[EXECUTION_ROUTER] 请立即调用工具 `%TOOL_NAME%`，并在参数中完整写入思考清单与最终 JSON 结果，不要在普通正文回复中作答。',
      },
    ],
    ...overrides,
  };
}

function randomHex(byteLen = 8): string {
  const bytes = new Uint8Array(byteLen);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** 生成工具名：dynamic 模式生成 `<prefix><16位hex>`，fixed 模式取固定名。 */
export function generateSyntheticToolName(
  prefix = 'agw_emit_',
  fixedName = 'emit_illustration_plan',
  nameMode: 'dynamic' | 'fixed' = 'dynamic',
): string {
  if (nameMode === 'fixed' && fixedName.trim()) {
    return fixedName.trim();
  }
  const cleanPrefix = prefix.trim() || 'agw_emit_';
  return `${cleanPrefix}${randomHex(8)}`;
}

function replaceToolNamePlaceholder(text: string, toolName: string): string {
  return text
    .replaceAll('%TOOL_NAME%', toolName)
    .replaceAll('TOOL_NAME%', toolName);
}

function extractTextAndMedia(content: ChatMsg['content']): {
  text: string;
  mediaParts: ChatMsgContentPart[];
} {
  if (typeof content === 'string') return { text: content, mediaParts: [] };
  if (!Array.isArray(content)) return { text: '', mediaParts: [] };
  const texts: string[] = [];
  const mediaParts: ChatMsgContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'image_url' && part.image_url?.url) mediaParts.push(part);
  }
  return { text: texts.join('\n'), mediaParts };
}

function resolveToolChoice(mode: ToolCallPresetConfig['toolChoice'], toolName: string): ToolChoice {
  if (mode === 'required') return 'required';
  if (mode === 'function') return { type: 'function', function: { name: toolName } };
  return 'auto';
}

const DEFAULT_GUIDE_TRANSCRIPT: Array<{ role: 'system' | 'user'; content: string }> = [
  {
    role: 'system',
    content:
      '[SYSTEM_RUNTIME_INIT] You are running inside a structured workspace archive pipeline. Inspect the archived specification and task data attached in tool `%TOOL_NAME%` and emit the complete formatted payload strictly via `%TOOL_NAME%`.',
  },
  {
    role: 'user',
    content:
      '[RUNTIME_ROUTER] Read the full specification and story material archived inside `%TOOL_NAME%`, then invoke `%TOOL_NAME%` once with the complete output stream.',
  },
];

/**
 * Mode A / Mode B ToolCall 请求变换。
 * - Mode A（引导包裹）：`config.guideWrap === true` 或 `guideIndices.length > 0`
 * - Mode B（标准隧道）：保留 `messages[]` + 可选尾部消息 + 合成工具
 */
export function transformForToolTunnel(
  messages: ChatMsg[],
  config: ToolCallPresetConfig,
  guideIndices: number[] = [],
): ToolTunnelTransformResult {
  const toolName = generateSyntheticToolName(config.prefix, config.fixedName, config.nameMode);
  const guideSet = new Set(guideIndices);
  const useGuideWrap = config.guideWrap || guideSet.size > 0;
  const toolChoice = resolveToolChoice(config.toolChoice, toolName);

  if (useGuideWrap) {
    const archiveTexts: string[] = [];
    const mediaParts: ChatMsgContentPart[] = [];
    const guideMsgs: ChatMsg[] = [];

    messages.forEach((msg, index) => {
      const { text, mediaParts: media } = extractTextAndMedia(msg.content);
      if (guideSet.has(index)) {
        const cleanText = replaceToolNamePlaceholder(
          text.replace(/【ToolCall引导】/g, '').trim(),
          toolName,
        );
        if (cleanText || media.length) {
          guideMsgs.push({
            role: msg.role === 'tool' ? 'user' : msg.role,
            content: media.length ? [{ type: 'text', text: cleanText }, ...media] : cleanText,
          });
        }
      } else {
        if (text.trim()) archiveTexts.push(text.trim());
        if (media.length) mediaParts.push(...media);
      }
    });

    const finalGuides: ChatMsg[] = guideMsgs.length
      ? guideMsgs
      : DEFAULT_GUIDE_TRANSCRIPT.map(g => ({
          role: g.role,
          content: replaceToolNamePlaceholder(g.content, toolName),
        }));

    // 剥离末尾悬空的 assistant 预填，确保以 user 回合结尾
    while (finalGuides.length > 1 && finalGuides[finalGuides.length - 1].role === 'assistant') {
      finalGuides.pop();
    }
    if (!finalGuides.some(m => m.role === 'user')) {
      finalGuides.push({
        role: 'user',
        content: replaceToolNamePlaceholder('Execute task via `%TOOL_NAME%`.', toolName),
      });
    }

    if (mediaParts.length) {
      for (let i = finalGuides.length - 1; i >= 0; i--) {
        if (finalGuides[i].role === 'user') {
          const prev = finalGuides[i].content;
          const prevParts: ChatMsgContentPart[] =
            typeof prev === 'string' ? [{ type: 'text', text: prev }] : [...prev];
          finalGuides[i] = { ...finalGuides[i], content: [...prevParts, ...mediaParts] };
          break;
        }
      }
    }

    const header = (config.guideArchiveHeader || '【/workspace/archive/ 本地工作目录文件与业务规约】：').trim();
    const fieldName = (config.guideFieldName || 'display_stream').trim() || 'display_stream';
    const fieldDesc = replaceToolNamePlaceholder(
      config.guideFieldDesc || '写入完整的格式化输出流。',
      toolName,
    );
    const archiveBody = archiveTexts.join('\n\n---\n\n');
    const toolDesc = archiveBody ? `${header}\n${archiveBody}` : header;

    const field: ToolTunnelField = {
      name: fieldName,
      description: fieldDesc,
      required: true,
      wrapTag: '',
    };

    const tools: OpenAiToolDef[] = [
      {
        type: 'function',
        function: {
          name: toolName,
          description: toolDesc,
          parameters: {
            type: 'object',
            properties: {
              [fieldName]: {
                type: 'string',
                description: fieldDesc,
              },
            },
            required: [fieldName],
          },
        },
      },
    ];

    return {
      toolName,
      messages: finalGuides,
      tools,
      toolChoice,
      fields: [field],
      mode: 'guide_wrap',
    };
  }

  // Mode B：标准隧道
  const activeFields: ToolTunnelField[] = config.fields.length
    ? config.fields
    : defaultToolCallConfig().fields;

  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const f of activeFields) {
    const key = f.name.trim();
    if (!key) continue;
    properties[key] = {
      type: 'string',
      description: replaceToolNamePlaceholder(f.description || '', toolName),
    };
    if (f.required) required.push(key);
  }

  const tools: OpenAiToolDef[] = [
    {
      type: 'function',
      function: {
        name: toolName,
        description: replaceToolNamePlaceholder(config.description || '', toolName),
        parameters: {
          type: 'object',
          properties,
          ...(required.length ? { required } : {}),
        },
      },
    },
  ];

  const outMessages: ChatMsg[] = messages.map(m => ({ ...m }));
  if (config.enableTailMessages && Array.isArray(config.tailMessages)) {
    for (const tail of config.tailMessages) {
      if (!tail.enabled || !tail.content.trim()) continue;
      outMessages.push({
        role: tail.role,
        content: replaceToolNamePlaceholder(tail.content, toolName),
      });
    }
  }

  return {
    toolName,
    messages: outMessages,
    tools,
    toolChoice,
    fields: activeFields,
    mode: 'standard_tunnel',
  };
}

/**
 * Mode C：根据 AutoTagProfile 动态生成强类型结构化 Tool Schema。
 * 返回单个 tool 定义与建议 toolChoice。
 */
export function buildStructuredPlanTool(
  profile: AutoTagProfile,
  minImages: number,
  maxImages: number,
): { toolName: string; tools: OpenAiToolDef[]; toolChoice: ToolChoice } {
  const changeItemSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      name: { type: 'string', description: '角色名（与正文或库条目逐字一致）' },
      field: {
        type: 'string',
        enum: ['new', 'fandom', 'sex', 'hair', 'eyes', 'skin', 'body', 'extra', 'outfit', 'raw', 'nl'],
      },
      value: { type: 'string', description: '非 new 变更的新值' },
      fields: {
        type: 'object',
        description: 'field 为 new 时填写各外貌字段（hair 与 eyes 必填）',
        properties: {
          fandom: { type: 'string' },
          sex: { type: 'string' },
          hair: { type: 'string' },
          eyes: { type: 'string' },
          skin: { type: 'string' },
          body: { type: 'string' },
          extra: { type: 'string' },
          outfit: { type: 'string' },
        },
      },
      nl: { type: 'string', description: '自然语言外貌描述' },
      position: { type: 'string', description: 'P编号，如 P1' },
      reason: { type: 'string', description: '建档或永久变化原因' },
    },
    required: ['name', 'field'],
  };

  if (profile.comic) {
    const toolName = 'submit_comic_plan';
    const pageItemProperties: Record<string, unknown> = {
      position: { type: 'string', description: '段落锚点 P编号，如 P2' },
      summary: { type: 'string', description: '整页英文自然语言概要（含 full color 等画风基调）' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', enum: ['character', 'object', 'text'] },
            name: { type: 'string', description: '仅 label=character 且在库中建档时填写角色名' },
            caption: { type: 'string', description: '英文短句画面描述' },
            text: { type: 'string', description: '仅 label=text 时填写对白文字' },
            bbox: {
              type: 'array',
              items: { type: 'number' },
              minItems: 4,
              maxItems: 4,
              description: '0-1000 归一化坐标 [y0, x0, y1, x1]',
            },
          },
          required: ['label', 'bbox'],
        },
      },
    };
    if (!profile.lockedSize) {
      pageItemProperties.size = { type: 'string', enum: ['portrait', 'landscape'] };
    }
    const pageRequired = profile.lockedSize ? ['position', 'summary', 'items'] : ['position', 'summary', 'items', 'size'];
    return {
      toolName,
      toolChoice: { type: 'function', function: { name: toolName } },
      tools: [
        {
          type: 'function',
          function: {
            name: toolName,
            description: '提交漫画分页分镜（pages）与角色档案变更（changes）。',
            parameters: {
              type: 'object',
              properties: {
                thinking: { type: 'string', description: '简明三层思维链核对过程' },
                pages: {
                  type: 'array',
                  minItems: 1,
                  items: { type: 'object', properties: pageItemProperties, required: pageRequired },
                },
                changes: { type: 'array', items: changeItemSchema },
              },
              required: ['pages', 'changes'],
            },
          },
        },
      ],
    };
  }

  const toolName = 'submit_illustration_plan';
  const imageProperties: Record<string, unknown> = {
    position: { type: 'string', description: '段落锚点 P编号，如 P2' },
    tag: { type: 'string', description: '英文 Danbooru 正向短 tag' },
  };
  const imageRequired = ['position', 'tag'];

  if (profile.nl) {
    imageProperties.nl = { type: 'string', description: '英文自然语言画面描述' };
    imageRequired.push('nl');
  }
  if (profile.naiCharPrompts) {
    const charItemProps: Record<string, unknown> = {
      name: { type: 'string', description: '角色名' },
      tag: { type: 'string', description: '该角色英文 Danbooru tag（用 girl/boy）' },
    };
    const charReq = ['name', 'tag'];
    if (profile.nl) {
      charItemProps.nl = { type: 'string', description: '该角色英文自然语言描述' };
      charReq.push('nl');
    }
    imageProperties.characters = {
      type: 'array',
      items: { type: 'object', properties: charItemProps, required: charReq },
    };
    imageRequired.push('characters');
  } else {
    imageProperties.negative = { type: 'string', description: '可选动态负面 tag' };
  }
  if (!profile.lockedSize) {
    imageProperties.size = { type: 'string', enum: ['portrait', 'landscape'] };
    imageRequired.push('size');
  }

  return {
    toolName,
    toolChoice: { type: 'function', function: { name: toolName } },
    tools: [
      {
        type: 'function',
        function: {
          name: toolName,
          description: `提交本轮生图规划（images，数量范围 ${minImages}..${maxImages}）与角色档案变更（changes）。`,
          parameters: {
            type: 'object',
            properties: {
              thinking: { type: 'string', description: '简明三层思维链核对过程' },
              images: {
                type: 'array',
                minItems: minImages,
                maxItems: maxImages,
                items: { type: 'object', properties: imageProperties, required: imageRequired },
              },
              changes: { type: 'array', items: changeItemSchema },
            },
            required: ['images', 'changes'],
          },
        },
      },
    ],
  };
}
