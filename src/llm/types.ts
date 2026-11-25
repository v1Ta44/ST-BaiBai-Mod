import type { ChatMsg, OpenAiToolDef, ToolChoice } from '@/api/client';

/** 提示词预设的三档输出协议模式 */
export type OutputMode = 'text_json' | 'tool_tunnel' | 'tool_structured';

export interface ToolTunnelField {
  name: string;
  description: string;
  required: boolean;
  /** 可选：解码时用 `<wrapTag>...</wrapTag>` 包裹该字段输出 */
  wrapTag?: string;
}

export interface TailMessage {
  id: string;
  enabled: boolean;
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ToolCallPresetConfig {
  nameMode: 'dynamic' | 'fixed';
  prefix: string;
  fixedName: string;
  toolChoice: 'auto' | 'required' | 'function';
  description: string;
  fields: ToolTunnelField[];
  /** Mode A（引导包裹）：把全部非引导上下文打包进 tool.description */
  guideWrap: boolean;
  guideArchiveHeader: string;
  guideFieldName: string;
  guideFieldDesc: string;
  /** Mode B（标准隧道）：在 messages 末尾追加可编辑尾部引导消息 */
  enableTailMessages: boolean;
  tailMessages: TailMessage[];
}

export interface ToolTunnelTransformResult {
  toolName: string;
  messages: ChatMsg[];
  tools: OpenAiToolDef[];
  toolChoice: ToolChoice;
  fields: ToolTunnelField[];
  mode: 'guide_wrap' | 'standard_tunnel';
}
