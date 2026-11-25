import { describe, expect, it } from 'vitest';
import {
  decodeTunnelResponse,
  extractToolCallArguments,
  IncrementalStringDecoder,
  StreamToolCallDecoder,
} from './toolCallDecoder';
import type { ToolTunnelField } from './types';

describe('IncrementalStringDecoder', () => {
  it('decodes escapes and unicode sequences split arbitrarily across chunks', () => {
    const dec = new IncrementalStringDecoder();
    const input = 'line1\\n\\"quoted\\" \\\\ \\u4e2d\\u6587';
    let out = '';
    for (let i = 0; i < input.length; i += 2) {
      out += dec.feed(input.slice(i, i + 2));
    }
    out += dec.flushPartial();
    expect(out).toBe('line1\n"quoted" \\ 中文');
  });
});

describe('extractToolCallArguments', () => {
  const fields: ToolTunnelField[] = [
    { name: 'thinking', description: '', required: false, wrapTag: 'thinking' },
    { name: 'payload', description: '', required: true },
  ];

  it('parses valid JSON and wraps tagged fields', () => {
    const raw = JSON.stringify({
      thinking: '构图分析',
      payload: '{"images":[{"position":"P1","tag":"1girl"}],"changes":[]}',
    });
    expect(extractToolCallArguments(raw, fields)).toBe(
      '<thinking>构图分析</thinking>\n{"images":[{"position":"P1","tag":"1girl"}],"changes":[]}',
    );
  });

  it('recovers unclosed truncated JSON arguments via regex fallback', () => {
    const truncated = '{"payload":"{\\"images\\":[{\\"position\\":\\"P1\\",\\"tag\\":\\"1girl';
    expect(extractToolCallArguments(truncated, fields)).toBe(
      '{"images":[{"position":"P1","tag":"1girl',
    );
  });
});

describe('StreamToolCallDecoder', () => {
  const fields: ToolTunnelField[] = [
    { name: 'thinking', description: '', required: false, wrapTag: 'thinking' },
    { name: 'payload', description: '', required: true },
  ];

  it('streams chunks through 5-state FSM with wrapTag and returns {content, reasoning} fallback', () => {
    const decoder = new StreamToolCallDecoder(fields);
    const full = JSON.stringify({
      thinking: '先看人物',
      payload: '{"images":[],"changes":[]}',
    });

    let streamedContent = '';
    let streamedReasoning = '';
    // 按 3 字符碎片喂入，跨过转义符与引号边界
    for (let i = 0; i < full.length; i += 3) {
      const d = decoder.feed(full.slice(i, i + 3));
      streamedContent += d.content;
      streamedReasoning += d.reasoning;
    }

    expect(streamedReasoning).toBe('<thinking>先看人物</thinking>\n');
    expect(streamedContent).toBe('{"images":[],"changes":[]}\n');

    const fb = decoder.getFinalFallback();
    expect(typeof fb).toBe('object');
    expect(fb.reasoning).toBe('<thinking>先看人物</thinking>');
    expect(fb.content).toContain('<thinking>先看人物</thinking>');
    expect(fb.content).toContain('{"images":[],"changes":[]}');
  });

  it('recovers truncated stream via getFinalFallback().content without returning string', () => {
    const decoder = new StreamToolCallDecoder([
      { name: 'display_stream', description: '', required: true },
    ]);
    decoder.feed('{"display_stream":"<thinking>ok</thinking>\\n{\\"images\\":[');
    const fb = decoder.getFinalFallback();
    expect(typeof fb).toBe('object');
    expect(fb.content).toBe('<thinking>ok</thinking>\n{"images":[');
  });
});

describe('decodeTunnelResponse', () => {
  it('decodes matched tool call and falls back to plain content when model did not invoke tools', () => {
    const fields: ToolTunnelField[] = [{ name: 'display_stream', description: '', required: true }];
    expect(
      decodeTunnelResponse(
        {
          content: '',
          toolCalls: [
            {
              id: '1',
              type: 'function',
              function: { name: 'agw_emit_1234', arguments: '{"display_stream":"hello"}' },
            },
          ],
        },
        'agw_emit_1234',
        fields,
      ),
    ).toEqual({ text: 'hello', usedToolCall: true });

    expect(decodeTunnelResponse({ content: '{"images":[],"changes":[]}' }, 'agw_emit_1234', fields)).toEqual({
      text: '{"images":[],"changes":[]}',
      usedToolCall: false,
    });
  });
});
