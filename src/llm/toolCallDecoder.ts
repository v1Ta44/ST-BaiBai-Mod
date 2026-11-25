import type { LlmResponse, RawToolCall } from '@/api/client';
import type { ToolTunnelField } from '@/llm/types';

/**
 * 增量 JSON 字符串解码器：逐字符状态机处理 `\n`、`\"`、`\\`、`\uXXXX` 等转义，
 * 支持任意 SSE 分片在反斜杠或 Unicode 转义序列中途断开。
 */
export class IncrementalStringDecoder {
  private escaping = false;
  private unicodeRemaining = 0;
  private unicodeHex = '';

  feed(chunk: string): string {
    let out = '';
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (this.unicodeRemaining > 0) {
        if (/^[0-9a-fA-F]$/.test(ch)) {
          this.unicodeHex += ch;
          this.unicodeRemaining--;
          if (this.unicodeRemaining === 0) {
            out += String.fromCharCode(Number.parseInt(this.unicodeHex, 16));
            this.unicodeHex = '';
          }
        } else {
          // 非法转义原样吐出并复位
          out += `\\u${this.unicodeHex}${ch}`;
          this.unicodeHex = '';
          this.unicodeRemaining = 0;
        }
        continue;
      }

      if (this.escaping) {
        this.escaping = false;
        if (ch === 'n') out += '\n';
        else if (ch === 'r') out += '\r';
        else if (ch === 't') out += '\t';
        else if (ch === 'b') out += '\b';
        else if (ch === 'f') out += '\f';
        else if (ch === '"' || ch === '\\' || ch === '/') out += ch;
        else if (ch === 'u') {
          this.unicodeRemaining = 4;
          this.unicodeHex = '';
        } else {
          out += ch;
        }
        continue;
      }

      if (ch === '\\') {
        this.escaping = true;
      } else {
        out += ch;
      }
    }
    return out;
  }

  flushPartial(): string {
    let out = '';
    if (this.escaping) {
      out += '\\';
      this.escaping = false;
    }
    if (this.unicodeRemaining > 0) {
      out += `\\u${this.unicodeHex}`;
      this.unicodeHex = '';
      this.unicodeRemaining = 0;
    }
    return out;
  }
}

function unescapeJsonFragment(raw: string): string {
  const dec = new IncrementalStringDecoder();
  return dec.feed(raw) + dec.flushPartial();
}

function wrapField(value: string, wrapTag?: string): string {
  const tag = wrapTag?.trim();
  if (!tag || !value.trim()) return value;
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  if (value.includes(open) && value.includes(close)) return value;
  return `${open}${value}${close}`;
}

/**
 * 从工具调用 arguments 字符串提取最终文本。
 * 优先完整 JSON.parse；若 JSON 被截断未闭合，使用正则兜底提取未闭合字符串值。
 */
export function extractToolCallArguments(rawArgs: string, fields: ToolTunnelField[] = []): string {
  if (!rawArgs || typeof rawArgs !== 'string') return '';
  const trimmed = rawArgs.trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (fields.length > 0) {
        const parts: string[] = [];
        for (const f of fields) {
          const val = obj[f.name];
          if (typeof val === 'string' && val) {
            parts.push(wrapField(val, f.wrapTag));
          } else if (val !== undefined && val !== null && typeof val !== 'string') {
            parts.push(wrapField(JSON.stringify(val), f.wrapTag));
          }
        }
        if (parts.length) return parts.join('\n').trim();
      }
      // 未命中指定字段名时，拼接所有字符串字段作为容错
      const fallbackParts = Object.values(obj)
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
      if (fallbackParts.length) return fallbackParts.join('\n').trim();
    }
  } catch {
    // 截断或轻微畸形 JSON，进入正则兜底
  }

  const targetKeys = fields.length ? fields.map(f => f.name) : [];
  if (targetKeys.length) {
    const parts: string[] = [];
    for (const f of fields) {
      const escapedKey = f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`"${escapedKey}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)(?:"|$)`);
      const m = trimmed.match(re);
      if (m && m[1]) {
        parts.push(wrapField(unescapeJsonFragment(m[1]), f.wrapTag));
      }
    }
    if (parts.length) return parts.join('\n').trim();
  }

  // 最后通配任意首个字符串键值
  const generic = trimmed.match(/"[^"]+"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/);
  if (generic && generic[1]) {
    return unescapeJsonFragment(generic[1]).trim();
  }
  return '';
}

type FsmState =
  | 'LOOKING_FOR_KEY'
  | 'IN_KEY'
  | 'LOOKING_FOR_COLON'
  | 'LOOKING_FOR_QUOTE'
  | 'IN_STRING'
  | 'DONE';

/**
 * 5 态流式 ToolCall JSON 字符串增量解码器。
 * 彻底修复原版 `getFinalFallback()` 返回 string 导致读取 `.content` 为 undefined 的 Bug，
 * 严格返回 `{ content: string; reasoning: string }`。
 */
export class StreamToolCallDecoder {
  private state: FsmState = 'LOOKING_FOR_KEY';
  private rawAccumulated = '';
  private keyBuf = '';
  private keyEscaping = false;
  private currentKey = '';
  private currentField: ToolTunnelField | null = null;
  private valueDecoder = new IncrementalStringDecoder();
  private inStringEscaping = false;
  private emittedContent = '';
  private emittedReasoning = '';
  private fieldOpenedTag = false;
  private fieldMap = new Map<string, ToolTunnelField>();

  constructor(private readonly fields: ToolTunnelField[] = []) {
    for (const f of fields) {
      if (f.name) this.fieldMap.set(f.name, f);
    }
  }

  private emitText(piece: string, isThinking: boolean): { content: string; reasoning: string } {
    if (!piece) return { content: '', reasoning: '' };
    if (isThinking) {
      this.emittedReasoning += piece;
      return { content: '', reasoning: piece };
    }
    this.emittedContent += piece;
    return { content: piece, reasoning: '' };
  }

  feed(argsDelta: string): { content: string; reasoning: string } {
    if (!argsDelta) return { content: '', reasoning: '' };
    this.rawAccumulated += argsDelta;

    let deltaContent = '';
    let deltaReasoning = '';

    for (let i = 0; i < argsDelta.length; i++) {
      const ch = argsDelta[i];

      if (this.state === 'DONE') break;

      if (this.state === 'LOOKING_FOR_KEY') {
        if (ch === '"') {
          this.state = 'IN_KEY';
          this.keyBuf = '';
          this.keyEscaping = false;
        }
        continue;
      }

      if (this.state === 'IN_KEY') {
        if (this.keyEscaping) {
          this.keyEscaping = false;
          this.keyBuf += ch;
        } else if (ch === '\\') {
          this.keyEscaping = true;
        } else if (ch === '"') {
          this.currentKey = this.keyBuf;
          this.state = 'LOOKING_FOR_COLON';
        } else {
          this.keyBuf += ch;
        }
        continue;
      }

      if (this.state === 'LOOKING_FOR_COLON') {
        if (ch === ':') {
          this.state = 'LOOKING_FOR_QUOTE';
        } else if (!/\s/.test(ch)) {
          this.state = 'LOOKING_FOR_KEY';
        }
        continue;
      }

      if (this.state === 'LOOKING_FOR_QUOTE') {
        if (ch === '"') {
          const matchedField =
            this.fieldMap.get(this.currentKey) ??
            (this.fields.length === 0 ? { name: this.currentKey, description: '', required: true } : null);
          if (matchedField) {
            this.currentField = matchedField;
            this.valueDecoder = new IncrementalStringDecoder();
            this.inStringEscaping = false;
            this.state = 'IN_STRING';
            const tag = matchedField.wrapTag?.trim();
            if (tag) {
              this.fieldOpenedTag = true;
              const open = `<${tag}>`;
              const r = this.emitText(open, tag === 'thinking' || tag === 'think');
              deltaContent += r.content;
              deltaReasoning += r.reasoning;
            } else {
              this.fieldOpenedTag = false;
            }
          } else {
            // 非目标字符串字段，跳过
            this.currentField = null;
            this.inStringEscaping = false;
            this.state = 'IN_STRING';
          }
        } else if (ch === '{' || ch === '[' || ch === 't' || ch === 'f' || ch === 'n' || /[-0-9]/.test(ch)) {
          // 非字符串值，退回继续找下一个键
          this.state = 'LOOKING_FOR_KEY';
        }
        continue;
      }

      if (this.state === 'IN_STRING') {
        if (this.inStringEscaping) {
          this.inStringEscaping = false;
          if (this.currentField) {
            const decoded = this.valueDecoder.feed(ch);
            const isThinking =
              this.currentField.wrapTag === 'thinking' || this.currentField.wrapTag === 'think';
            const r = this.emitText(decoded, isThinking);
            deltaContent += r.content;
            deltaReasoning += r.reasoning;
          }
          continue;
        }
        if (ch === '\\') {
          this.inStringEscaping = true;
          if (this.currentField) {
            const decoded = this.valueDecoder.feed(ch);
            const isThinking =
              this.currentField.wrapTag === 'thinking' || this.currentField.wrapTag === 'think';
            const r = this.emitText(decoded, isThinking);
            deltaContent += r.content;
            deltaReasoning += r.reasoning;
          }
          continue;
        }
        if (ch === '"') {
          if (this.currentField) {
            const rest = this.valueDecoder.flushPartial();
            const isThinking =
              this.currentField.wrapTag === 'thinking' || this.currentField.wrapTag === 'think';
            if (rest) {
              const r = this.emitText(rest, isThinking);
              deltaContent += r.content;
              deltaReasoning += r.reasoning;
            }
            const tag = this.currentField.wrapTag?.trim();
            if (tag && this.fieldOpenedTag) {
              const r = this.emitText(`</${tag}>`, isThinking);
              deltaContent += r.content;
              deltaReasoning += r.reasoning;
            }
            if (this.emittedContent || this.emittedReasoning) {
              const r = this.emitText('\n', isThinking);
              deltaContent += r.content;
              deltaReasoning += r.reasoning;
            }
          }
          this.currentField = null;
          this.fieldOpenedTag = false;
          this.state = 'LOOKING_FOR_KEY';
          continue;
        }
        if (this.currentField) {
          const decoded = this.valueDecoder.feed(ch);
          const isThinking =
            this.currentField.wrapTag === 'thinking' || this.currentField.wrapTag === 'think';
          const r = this.emitText(decoded, isThinking);
          deltaContent += r.content;
          deltaReasoning += r.reasoning;
        }
      }
    }

    return { content: deltaContent, reasoning: deltaReasoning };
  }

  /** 获取完整聚合或截断兜底结果（严格返回对象，绝不返回裸 string）。 */
  getFinalFallback(): { content: string; reasoning: string } {
    if (this.state === 'IN_STRING' && this.currentField) {
      const rest = this.valueDecoder.flushPartial();
      if (rest) {
        const isThinking =
          this.currentField.wrapTag === 'thinking' || this.currentField.wrapTag === 'think';
        this.emitText(rest, isThinking);
      }
    }
    if (this.emittedContent.trim() || this.emittedReasoning.trim()) {
      const combined = [this.emittedReasoning.trim(), this.emittedContent.trim()]
        .filter(Boolean)
        .join('\n');
      return {
        content: combined || this.emittedContent.trim(),
        reasoning: this.emittedReasoning.trim(),
      };
    }
    const recovered = extractToolCallArguments(this.rawAccumulated, this.fields);
    return { content: recovered, reasoning: '' };
  }
}

export function pickTargetToolCall(
  toolCalls: RawToolCall[] | undefined,
  expectedToolName?: string,
): RawToolCall | null {
  if (!toolCalls?.length) return null;
  if (expectedToolName) {
    const exact = toolCalls.find(tc => tc.function.name === expectedToolName);
    if (exact) return exact;
  }
  if (toolCalls.length === 1) return toolCalls[0];
  return (
    toolCalls.find(
      tc =>
        tc.function.name.startsWith('agw_emit_') ||
        tc.function.name.startsWith('submit_') ||
        tc.function.name.startsWith('emit_'),
    ) ?? toolCalls[0]
  );
}

/**
 * 解码 Mode A / Mode B ToolCall 响应：
 * - 命中 `toolCalls` → 解出文本返回 `{ text, usedToolCall: true }`
 * - 模型未调工具直接吐正文 → 自动平滑降级返回 `{ text: response.content, usedToolCall: false }`
 */
export function decodeTunnelResponse(
  response: LlmResponse,
  expectedToolName?: string,
  fields: ToolTunnelField[] = [],
): { text: string; usedToolCall: boolean } {
  const tc = pickTargetToolCall(response.toolCalls, expectedToolName);
  if (tc?.function.arguments) {
    const decoded = extractToolCallArguments(tc.function.arguments, fields);
    if (decoded) return { text: decoded, usedToolCall: true };
  }
  return { text: response.content.trim(), usedToolCall: false };
}
