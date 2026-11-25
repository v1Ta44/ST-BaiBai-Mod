import { getContext } from '@/st/context';
import { getChannelOverride, type ApiChannel, type DirectChannelOverride } from '@/state/settings';
import {
  beginLlm,
  failLlm,
  finishLlm,
  patchLlmTokens,
  safeHistory,
} from '@/state/history';

/**
 * 浏览器直连 OpenAI 兼容协议客户端（不经过酒馆服务端代理）。
 *
 * - 支持非流式 JSON 与 SSE 流式增量（含 `delta.tool_calls` 按 index 分片拼接）
 * - 支持独立参数开关、自定义 Headers / Body JSON 合并与 `excludeParams` 删除
 * - 支持多模态 `content` 数组与 `tool` / `tool_calls`
 */

const DEFAULT_TIMEOUT_SEC = 180;

export type ChatMsgContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface RawToolCall {
  id?: string;
  type?: 'function';
  index?: number;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatMsgContentPart[];
  tool_calls?: RawToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAiToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface LlmUsage {
  prompt: number | null;
  completion: number | null;
}

export interface LlmResponse {
  content: string;
  reasoning?: string;
  toolCalls?: RawToolCall[];
  usage?: LlmUsage;
  rawResponse?: unknown;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 规范化 OpenAI 兼容 Base URL：
 * - 去尾斜杠；
 * - 若以 `/chat/completions` 或 `/models` 结尾先剥离；
 * - 若路径为空或不含 `/v\d` 版本路径（仅纯域名时），补 `/v1`；保留 `/v2/coding` 等自定义路径。
 */
export function normalizeOpenAiBaseUrl(rawUrl: string): string {
  let u = String(rawUrl ?? '').trim().replace(/\/+$/, '');
  if (!u) return u;
  u = u.replace(/\/chat\/completions$/i, '').replace(/\/models$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(u)) return `${u}/v1`;
  return u;
}

function alternateUrl(url: string): string {
  return /\/v1$/i.test(url) ? url.replace(/\/v1$/i, '') : `${url}/v1`;
}

export interface RequestOptions {
  signal?: AbortSignal;
  source?: string;
  override?: DirectChannelOverride;
  tools?: OpenAiToolDef[];
  toolChoice?: ToolChoice;
  outputMode?: string;
  presetName?: string;
  /** 若传入，先于历史记录入库校验（文本便捷模式使用）。 */
  validate?: (content: string) => void;
  /** 完整响应对象校验（tool_calls 模式使用），可返回解码后文本用于历史展示。 */
  validateResponse?: (res: LlmResponse) => string | void;
  /** SSE 流式 delta.tool_calls 分片实时回调。 */
  onToolCallDelta?: (deltas: RawToolCall[]) => void;
  /** SSE 流式普通正文分片回调。 */
  onContentDelta?: (chunk: string) => void;
}

function parseJsonObject(raw: string | undefined, label: string): Record<string, unknown> {
  const text = (raw ?? '').trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ApiError(`${label} 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(`${label} 必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

/** 构造直连请求头（合并自定义 Headers）。 */
export function buildDirectHeaders(
  channel: Pick<ApiChannel, 'key'>,
  override?: DirectChannelOverride,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const key = channel.key?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  const custom = parseJsonObject(override?.customHeaders, '自定义 Headers');
  for (const [k, v] of Object.entries(custom)) {
    if (k.trim() && v !== undefined && v !== null) {
      headers[k.trim()] = String(v);
    }
  }
  return headers;
}

/** 构造浏览器直连 OpenAI `/chat/completions` 请求体。 */
export function buildDirectRequestBody(
  channel: ApiChannel,
  messages: ChatMsg[],
  opts: {
    stream?: boolean;
    override?: DirectChannelOverride;
    tools?: OpenAiToolDef[];
    toolChoice?: ToolChoice;
  } = {},
): Record<string, unknown> {
  const ov = opts.override ?? {};
  const body: Record<string, unknown> = {
    model: channel.model,
    messages,
    stream: opts.stream ?? channel.stream ?? false,
  };

  if (ov.enableTemperature !== false) {
    body.temperature = channel.temperature ?? 1.0;
  }
  if (ov.enableTopP === true) {
    body.top_p = typeof ov.topP === 'number' && Number.isFinite(ov.topP) ? ov.topP : 1.0;
  }
  if (ov.enableMaxTokens !== false) {
    body.max_tokens = channel.maxTokens ?? 65535;
  }

  const effort = channel.reasoningEffort?.trim() ?? '';
  if (effort) {
    body.reasoning_effort = effort;
  }

  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? 'auto';
  } else if (opts.toolChoice !== undefined) {
    body.tool_choice = opts.toolChoice;
  }

  const customBody = parseJsonObject(ov.customBodyParams, '自定义 Body 参数');
  for (const [k, v] of Object.entries(customBody)) {
    body[k] = v;
  }

  for (const p of channel.excludeParams ?? []) {
    const key = p.trim();
    if (key) delete body[key];
  }
  return body;
}

/** 兼容旧测试/调用名的纯函数别名。 */
export function buildRequestBody(
  channel: ApiChannel,
  messages: ChatMsg[],
  stream: boolean,
  override?: DirectChannelOverride,
  tools?: OpenAiToolDef[],
  toolChoice?: ToolChoice,
): Record<string, unknown> {
  return buildDirectRequestBody(channel, messages, { stream, override, tools, toolChoice });
}

function readUsage(data: any): LlmUsage {
  const usage = data?.usage;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  return {
    prompt: num(usage?.prompt_tokens),
    completion: num(usage?.completion_tokens),
  };
}

function messageTextForEstimate(content: ChatMsg['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(p => (p.type === 'text' ? p.text : '')).join('\n');
}

async function estimateTokens(id: number, messages: ChatMsg[], responseText: string): Promise<void> {
  try {
    const count = getContext()?.getTokenCountAsync;
    if (typeof count !== 'function') return;
    const promptText = messages.map(m => messageTextForEstimate(m.content)).join('\n');
    const prompt = await count(promptText);
    const completion = responseText ? await count(responseText) : 0;
    safeHistory(() =>
      patchLlmTokens(
        id,
        typeof prompt === 'number' ? prompt : null,
        typeof completion === 'number' ? completion : null,
      ),
    );
  } catch (e) {
    console.debug('[柏宝·改] token 估算失败(已忽略)', e);
  }
}

function validTimeoutSec(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_SEC;
}

async function withTimeout<T>(
  timeoutSec: number,
  externalSignal: AbortSignal | undefined,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Math.max(1000, timeoutSec * 1000));

  try {
    return await task(ctrl.signal);
  } catch (e) {
    if (timedOut) throw new ApiError(`${label}超时(>${timeoutSec}秒)`);
    throw e;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    let out = '';
    for (const part of value) {
      if (typeof part === 'string') out += part;
      else if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') out += text;
      }
    }
    return out;
  }
  return '';
}

function normalizeRawToolCalls(raw: unknown): RawToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: RawToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const fn = obj.function as Record<string, unknown> | undefined;
    if (!fn || typeof fn !== 'object') continue;
    out.push({
      ...(typeof obj.id === 'string' ? { id: obj.id } : {}),
      type: 'function',
      ...(typeof obj.index === 'number' ? { index: obj.index } : {}),
      function: {
        name: typeof fn.name === 'string' ? fn.name : '',
        arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
      },
    });
  }
  return out;
}

/** 从非流式 JSON 提取完整 LlmResponse（含 content / reasoning / toolCalls / usage）。 */
export function extractLlmResponse(data: any): LlmResponse {
  const msg = data?.choices?.[0]?.message;
  const content = (
    textOf(msg?.content) ||
    textOf(data?.choices?.[0]?.text) ||
    textOf(data?.content)
  ).trim();
  const reasoning = (
    textOf(msg?.reasoning) ||
    textOf(msg?.reasoning_content) ||
    textOf(msg?.thinking)
  ).trim();
  const toolCalls = normalizeRawToolCalls(msg?.tool_calls);
  return {
    content: content || (toolCalls.length ? '' : reasoning),
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    usage: readUsage(data),
    rawResponse: data,
  };
}

/** 兼容旧版只取字符串结果的辅助函数。 */
export function extractContent(data: any): string {
  return extractLlmResponse(data).content;
}

/**
 * 读取 OpenAI SSE 流，同时拼接文本增量与 `delta.tool_calls` 分片。
 */
export async function readSseResponse(
  resp: Response,
  callbacks?: {
    onToolCallDelta?: (deltas: RawToolCall[]) => void;
    onContentDelta?: (chunk: string) => void;
  },
): Promise<LlmResponse> {
  const reader = resp.body?.getReader();
  if (!reader) {
    const data = await resp.json().catch(() => null);
    return data ? extractLlmResponse(data) : { content: '' };
  }
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let usage: LlmUsage = { prompt: null, completion: null };
  const toolMap = new Map<number, RawToolCall>();

  const processLine = (rawLine: string) => {
    const t = rawLine.trim();
    if (!t || !t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json?.error) throw new ApiError(json.error.message || '副 API 返回错误');
    if (json?.usage) usage = readUsage(json);

    const choice = json?.choices?.[0];
    const src = choice?.delta ?? choice?.message;
    const piece = textOf(src?.content) || textOf(choice?.text);
    if (piece) {
      content += piece;
      callbacks?.onContentDelta?.(piece);
    }
    const rPiece = textOf(src?.reasoning) || textOf(src?.reasoning_content) || textOf(src?.thinking);
    if (rPiece) reasoning += rPiece;

    if (Array.isArray(src?.tool_calls)) {
      const deltas: RawToolCall[] = [];
      for (const tc of src.tool_calls) {
        if (!tc || typeof tc !== 'object') continue;
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        let acc = toolMap.get(idx);
        if (!acc) {
          acc = {
            id: typeof tc.id === 'string' ? tc.id : '',
            type: 'function',
            index: idx,
            function: { name: '', arguments: '' },
          };
          toolMap.set(idx, acc);
        }
        if (typeof tc.id === 'string' && tc.id) acc.id = tc.id;
        const deltaName = typeof tc.function?.name === 'string' ? tc.function.name : '';
        const deltaArgs = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
        if (deltaName) acc.function.name += deltaName;
        if (deltaArgs) acc.function.arguments += deltaArgs;
        deltas.push({
          ...(acc.id ? { id: acc.id } : {}),
          type: 'function',
          index: idx,
          function: { name: deltaName, arguments: deltaArgs },
        });
      }
      if (deltas.length) callbacks?.onToolCallDelta?.(deltas);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) processLine(line);
  }
  if (buf.trim()) processLine(buf);

  const toolCalls = [...toolMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter(tc => tc.function.name || tc.function.arguments);

  return {
    content: content.trim() || (toolCalls.length ? '' : reasoning.trim()),
    ...(reasoning.trim() ? { reasoning: reasoning.trim() } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    usage,
  };
}

/** 兼容旧版只取 SSE 文本结果的辅助函数。 */
export async function readSseContent(resp: Response): Promise<string> {
  return (await readSseResponse(resp)).content;
}

function wrapDirectFetchError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof DOMException && error.name === 'AbortError') throw error;
  if (error instanceof TypeError) {
    throw new ApiError(
      `浏览器直连请求失败（请检查接口地址、网络或服务商是否允许跨域 CORS）：${error.message}`,
    );
  }
  throw error instanceof Error ? error : new ApiError(String(error));
}

async function requestCompletionRawAtUrl(
  channel: ApiChannel,
  messages: ChatMsg[],
  baseUrl: string,
  opts: RequestOptions = {},
): Promise<LlmResponse> {
  if (!channel.url?.trim() || !channel.model?.trim()) {
    throw new ApiError('副 API 渠道未配置完整（缺 URL 或模型名）');
  }

  const endpoint = `${baseUrl}/chat/completions`;
  const override = opts.override ?? getChannelOverride(channel.id);
  const stream = channel.stream ?? false;
  const headers = buildDirectHeaders(channel, override);
  const body = buildDirectRequestBody(channel, messages, {
    stream,
    override,
    tools: opts.tools,
    toolChoice: opts.toolChoice,
  });
  const timeoutSec = validTimeoutSec(channel.timeoutSec);

  const historyId = safeHistory(() =>
    beginLlm({
      source: opts.source || '未标注',
      channelName: channel.name || channel.model || '(未命名渠道)',
      model: channel.model,
      stream,
      messages,
      outputMode: opts.outputMode,
      presetName: opts.presetName,
      requestUrl: endpoint,
      tools: opts.tools,
    }),
  );

  let latestResponse: LlmResponse | null = null;
  let decodedText: string | undefined;
  try {
    const result = await withTimeout(timeoutSec, opts.signal, '副 API 直连请求', async signal => {
      let resp: Response;
      try {
        resp = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        wrapDirectFetchError(err);
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new ApiError(`副 API 请求失败 (${resp.status}): ${text.slice(0, 300)}`, resp.status);
      }

      const contentType = resp.headers?.get?.('content-type') ?? '';
      if (stream || contentType.includes('text/event-stream')) {
        const streamed = await readSseResponse(resp, {
          onToolCallDelta: opts.onToolCallDelta,
          onContentDelta: opts.onContentDelta,
        });
        if (!streamed.content && !streamed.toolCalls?.length) {
          throw new ApiError('空回复');
        }
        return streamed;
      }

      const data = await resp.json();
      if (data?.error) {
        throw new ApiError(data.error.message || '副 API 返回错误');
      }
      const parsed = extractLlmResponse(data);
      if (!parsed.content && !parsed.toolCalls?.length) {
        throw new ApiError('空回复');
      }
      return parsed;
    });

    latestResponse = result;
    if (opts.validateResponse) {
      const decoded = opts.validateResponse(result);
      if (typeof decoded === 'string') decodedText = decoded;
    } else if (opts.validate) {
      opts.validate(result.content);
    }

    const displayResponse =
      result.content ||
      (result.toolCalls?.length ? JSON.stringify(result.toolCalls, null, 2) : '');

    if (historyId !== null) {
      const promptTokens = result.usage?.prompt ?? null;
      const completionTokens = result.usage?.completion ?? null;
      const hasReal = promptTokens !== null;
      safeHistory(() =>
        finishLlm(historyId, {
          response: displayResponse,
          promptTokens,
          completionTokens,
          tokensEstimated: false,
          rawToolCalls: result.toolCalls,
          decodedText,
        }),
      );
      if (!hasReal) {
        void estimateTokens(historyId, messages, decodedText || displayResponse);
      }
    }
    return result;
  } catch (e) {
    if (historyId !== null) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      const rawText =
        latestResponse?.content ||
        (latestResponse?.toolCalls?.length
          ? JSON.stringify(latestResponse.toolCalls, null, 2)
          : '');
      safeHistory(() =>
        failLlm(
          historyId,
          e instanceof Error ? e.message : String(e),
          aborted,
          rawText,
          latestResponse?.toolCalls,
          decodedText,
        ),
      );
    }
    throw e;
  }
}

/** 浏览器直连 OpenAI `/chat/completions`，返回完整响应对象（含 toolCalls）。 */
export async function requestCompletionRaw(
  channel: ApiChannel,
  messages: ChatMsg[],
  opts: RequestOptions = {},
): Promise<LlmResponse> {
  return requestCompletionRawAtUrl(channel, messages, normalizeOpenAiBaseUrl(channel.url), opts);
}

/** 浏览器直连 OpenAI `/chat/completions`，返回正文字符串。 */
export async function requestCompletion(
  channel: ApiChannel,
  messages: ChatMsg[],
  opts: RequestOptions = {},
): Promise<string> {
  const res = await requestCompletionRaw(channel, messages, opts);
  return res.content;
}

/** 连通性测试：浏览器直连发送极短请求。 */
export async function testChannel(
  channel: ApiChannel,
  override?: DirectChannelOverride,
): Promise<{ ok: boolean; message: string }> {
  const primaryUrl = normalizeOpenAiBaseUrl(channel.url);
  try {
    const res = await requestCompletionRawAtUrl(
      channel,
      [{ role: 'user', content: '回复"ok"两个字符即可。' }],
      primaryUrl,
      { source: '连通性测试', override },
    );
    const changed = channel.url.trim().replace(/\/+$/, '') !== primaryUrl;
    if (changed) channel.url = primaryUrl;
    return {
      ok: true,
      message: `连通正常${changed ? `,已采用:${primaryUrl}` : ''},返回:${res.content.slice(0, 40)}`,
    };
  } catch (e) {
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    const fallbackUrl = alternateUrl(primaryUrl);
    if (!fallbackUrl || fallbackUrl === primaryUrl) {
      return { ok: false, message: e.message };
    }
    try {
      const res = await requestCompletionRawAtUrl(
        channel,
        [{ role: 'user', content: '回复"ok"两个字符即可。' }],
        fallbackUrl,
        { source: '连通性测试(备用地址)', override },
      );
      channel.url = fallbackUrl;
      return {
        ok: true,
        message: `连通正常,已自动改用:${fallbackUrl},返回:${res.content.slice(0, 40)}`,
      };
    } catch {
      return { ok: false, message: e.message };
    }
  }
}

/** 浏览器直连拉取渠道可用的模型列表 (`GET ${baseUrl}/models`)。 */
export async function fetchModels(
  channel: Pick<ApiChannel, 'url' | 'key'> & Partial<Pick<ApiChannel, 'timeoutSec' | 'id'>>,
  override?: DirectChannelOverride,
): Promise<string[]> {
  if (!channel.url?.trim()) throw new ApiError('请先填写 API 地址');
  const baseUrl = normalizeOpenAiBaseUrl(channel.url);
  const ov = override ?? (channel.id ? getChannelOverride(channel.id) : undefined);
  const headers = buildDirectHeaders(channel, ov);
  const timeoutSec = validTimeoutSec(channel.timeoutSec);

  return withTimeout(timeoutSec, undefined, '拉取模型', async signal => {
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers,
        signal,
      });
    } catch (err) {
      wrapDirectFetchError(err);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ApiError(`拉取模型失败 (${resp.status}): ${text.slice(0, 200)}`, resp.status);
    }

    const data = await resp.json();
    if (data?.error && !Array.isArray(data?.data)) {
      throw new ApiError(data?.message || data?.error?.message || '拉取模型失败');
    }

    const list: unknown = Array.isArray(data) ? data : (data?.data ?? data?.models ?? []);
    if (!Array.isArray(list)) return [];
    return list
      .map((m: any) => (typeof m === 'string' ? m : m?.id))
      .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
      .sort();
  });
}
