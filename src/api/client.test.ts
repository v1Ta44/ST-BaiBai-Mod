import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiChannel } from '@/state/settings';
import {
  ApiError,
  buildDirectHeaders,
  buildDirectRequestBody,
  extractContent,
  extractLlmResponse,
  fetchModels,
  normalizeOpenAiBaseUrl,
  readSseContent,
  readSseResponse,
  requestCompletion,
  requestCompletionRaw,
  type OpenAiToolDef,
  type RawToolCall,
} from './client';

const h = vi.hoisted(() => ({
  beginLlm: vi.fn(() => 1),
  finishLlm: vi.fn(),
  failLlm: vi.fn(),
  patchLlmTokens: vi.fn(),
}));

vi.mock('@/state/history', () => ({
  beginLlm: h.beginLlm,
  finishLlm: h.finishLlm,
  failLlm: h.failLlm,
  patchLlmTokens: h.patchLlmTokens,
  safeHistory: (fn: () => unknown) => {
    try {
      return fn();
    } catch {
      return null;
    }
  },
}));

vi.mock('@/st/context', () => ({
  getContext: () => ({}),
}));

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

const channel: ApiChannel = {
  id: 'ch1',
  name: '直连渠道',
  url: 'https://api.example.com',
  key: 'sk-test',
  model: 'gpt-4o',
  temperature: 0.8,
  maxTokens: 2048,
  timeoutSec: 60,
  stream: false,
  excludeParams: [],
  reasoningEffort: '',
};

const messages = [{ role: 'user' as const, content: 'hi' }];

beforeEach(() => {
  vi.restoreAllMocks();
  h.beginLlm.mockClear().mockReturnValue(1);
  h.finishLlm.mockClear();
  h.failLlm.mockClear();
  h.patchLlmTokens.mockClear();
});

describe('normalizeOpenAiBaseUrl', () => {
  it('appends /v1 for bare origins and strips /chat/completions or /models', () => {
    expect(normalizeOpenAiBaseUrl('https://api.example.com')).toBe('https://api.example.com/v1');
    expect(normalizeOpenAiBaseUrl('https://api.example.com/')).toBe('https://api.example.com/v1');
    expect(normalizeOpenAiBaseUrl('https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1',
    );
    expect(normalizeOpenAiBaseUrl('https://api.example.com/openai/v2/models')).toBe(
      'https://api.example.com/openai/v2',
    );
    expect(normalizeOpenAiBaseUrl('https://api.example.com/v2/coding')).toBe(
      'https://api.example.com/v2/coding',
    );
  });
});

describe('buildDirectHeaders & buildDirectRequestBody', () => {
  it('builds Bearer auth and merges customHeaders JSON', () => {
    const headers = buildDirectHeaders(channel, {
      customHeaders: '{"X-Custom":"val","Authorization":"Bearer override"}',
    });
    expect(headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer override',
      'X-Custom': 'val',
    });
  });

  it('throws clear ApiError on invalid customHeaders JSON', () => {
    expect(() => buildDirectHeaders(channel, { customHeaders: '{bad' })).toThrow(ApiError);
  });

  it('respects parameter toggles, reasoning_effort, tools, customBodyParams, and excludeParams', () => {
    const tools: OpenAiToolDef[] = [
      {
        type: 'function',
        function: {
          name: 'emit_plan',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
    const body = buildDirectRequestBody(
      { ...channel, reasoningEffort: 'high', excludeParams: ['temperature'] },
      messages,
      {
        stream: true,
        override: {
          enableTemperature: true,
          enableTopP: true,
          topP: 0.9,
          enableMaxTokens: false,
          customBodyParams: '{"seed":42}',
        },
        tools,
        toolChoice: 'required',
      },
    );
    expect(body).toEqual({
      model: 'gpt-4o',
      messages,
      stream: true,
      top_p: 0.9,
      reasoning_effort: 'high',
      tools,
      tool_choice: 'required',
      seed: 42,
    });
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it('omits tool_choice when no tools are passed', () => {
    const body = buildDirectRequestBody(channel, messages);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});

describe('extractLlmResponse & readSseResponse', () => {
  it('extracts content, reasoning, tool_calls, and usage from non-streaming response', () => {
    const res = extractLlmResponse({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: '思考过程',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'agw_emit_123', arguments: '{"a":1}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    expect(res.content).toBe('');
    expect(res.reasoning).toBe('思考过程');
    expect(res.toolCalls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'agw_emit_123', arguments: '{"a":1}' } },
    ]);
    expect(res.usage).toEqual({ prompt: 10, completion: 20 });
  });

  it('falls back to reasoning in extractContent when no toolCalls exist', () => {
    expect(
      extractContent({
        choices: [{ message: { content: '', reasoning_content: '深度思考结果' } }],
      }),
    ).toBe('深度思考结果');
  });

  it('reassembles split SSE delta.tool_calls across chunks by index and invokes delta callback', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"agw_emit_","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"abc","arguments":"{\\"x\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ok\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const deltas: RawToolCall[][] = [];
    const res = await readSseResponse(sseResponse(sse), {
      onToolCallDelta: d => deltas.push(d),
    });

    expect(deltas).toHaveLength(3);
    expect(res.toolCalls).toEqual([
      {
        id: 'call_9',
        type: 'function',
        index: 0,
        function: { name: 'agw_emit_abc', arguments: '{"x":"ok"}' },
      },
    ]);
    expect(res.usage).toEqual({ prompt: 12, completion: 8 });
  });

  it('reads normal SSE text content cleanly', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    await expect(readSseContent(sseResponse(sse))).resolves.toBe('hello world');
  });
});

describe('requestCompletionRaw & fetchModels (browser direct fetch)', () => {
  it('posts directly to ${base}/chat/completions without ST proxy and records decodedText', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{"k":"v"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 9 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await requestCompletionRaw(channel, messages, {
      source: '自动 tag',
      outputMode: 'tool_tunnel',
      presetName: '预设A',
      tools: [{ type: 'function', function: { name: 'fn', parameters: { type: 'object' } } }],
      validateResponse: r => `decoded:${r.toolCalls?.[0]?.function.arguments}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions');
    expect(res.toolCalls?.[0].function.name).toBe('fn');
    expect(h.beginLlm).toHaveBeenCalledWith(
      expect.objectContaining({
        outputMode: 'tool_tunnel',
        presetName: '预设A',
        requestUrl: 'https://api.example.com/v1/chat/completions',
      }),
    );
    expect(h.finishLlm).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        decodedText: 'decoded:{"k":"v"}',
        promptTokens: 5,
        completionTokens: 9,
      }),
    );
  });

  it('records failure in history when validateResponse throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: 'bad json' } }] }),
      ),
    );
    await expect(
      requestCompletion(channel, messages, {
        validate: () => {
          throw new Error('格式错误');
        },
      }),
    ).rejects.toThrow('格式错误');
    expect(h.failLlm).toHaveBeenCalledWith(1, '格式错误', false, 'bad json', undefined, undefined);
  });

  it('wraps TypeError from fetch into a clear CORS/network ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(requestCompletion(channel, messages)).rejects.toThrow(/CORS/);
  });

  it('fetches models directly from ${base}/models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ id: 'gpt-4o' }, { id: 'claude-sonnet' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const models = await fetchModels(channel);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/models');
    expect(models).toEqual(['claude-sonnet', 'gpt-4o']);
  });
});
