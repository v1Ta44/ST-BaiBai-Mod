import { describe, expect, it } from 'vitest';
import type { ChatMsg } from '@/api/client';
import {
  buildStructuredPlanTool,
  defaultToolCallConfig,
  generateSyntheticToolName,
  transformForToolTunnel,
} from './toolCallTransform';

describe('generateSyntheticToolName', () => {
  it('generates 16-hex nonce suffix in dynamic mode and uses fixedName in fixed mode', () => {
    expect(generateSyntheticToolName('agw_emit_', 'fixed_fn', 'dynamic')).toMatch(
      /^agw_emit_[0-9a-f]{16}$/,
    );
    expect(generateSyntheticToolName('agw_emit_', 'fixed_fn', 'fixed')).toBe('fixed_fn');
  });
});

describe('transformForToolTunnel', () => {
  const baseMessages: ChatMsg[] = [
    { role: 'system', content: '系统设定与规范' },
    { role: 'user', content: '剧情正文 ⟦P1⟧' },
  ];

  it('Mode B (standard_tunnel): preserves messages, appends enabled tail messages with %TOOL_NAME%', () => {
    const cfg = defaultToolCallConfig({
      nameMode: 'fixed',
      fixedName: 'custom_emit',
      toolChoice: 'required',
      enableTailMessages: true,
      tailMessages: [
        { id: '1', enabled: true, role: 'user', content: '请调用 %TOOL_NAME%' },
        { id: '2', enabled: false, role: 'assistant', content: '忽略我' },
      ],
    });
    const out = transformForToolTunnel(baseMessages, cfg);
    expect(out.mode).toBe('standard_tunnel');
    expect(out.toolName).toBe('custom_emit');
    expect(out.toolChoice).toBe('required');
    expect(out.messages).toHaveLength(3);
    expect(out.messages[2]).toEqual({ role: 'user', content: '请调用 custom_emit' });
    expect(out.tools[0].function.name).toBe('custom_emit');
    expect(out.tools[0].function.parameters).toMatchObject({
      type: 'object',
      required: ['thought_and_payload'],
    });
  });

  it('Mode A (guide_wrap via guideWrap=true): packs all non-guide messages into tool.description', () => {
    const cfg = defaultToolCallConfig({
      guideWrap: true,
      nameMode: 'fixed',
      fixedName: 'agw_emit_fixed',
      guideArchiveHeader: '【归档】：',
      guideFieldName: 'display_stream',
    });
    const out = transformForToolTunnel(baseMessages, cfg);
    expect(out.mode).toBe('guide_wrap');
    expect(out.tools[0].function.description).toContain('【归档】：\n系统设定与规范\n\n---\n\n剧情正文 ⟦P1⟧');
    expect(out.messages.every(m => !String(m.content).includes('剧情正文'))).toBe(true);
    expect(out.messages.some(m => String(m.content).includes('agw_emit_fixed'))).toBe(true);
    expect(out.messages[out.messages.length - 1].role).toBe('user');
  });

  it('Mode A (via guideIndices): uses explicit guide entries, strips trailing assistant, and preserves media', () => {
    const msgs: ChatMsg[] = [
      { role: 'system', content: '引导系统 %TOOL_NAME%' },
      { role: 'system', content: '世界书内容' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '参考图剧情' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
      { role: 'user', content: '执行引导 %TOOL_NAME%' },
      { role: 'assistant', content: '悬空预填' },
    ];
    const cfg = defaultToolCallConfig({ nameMode: 'fixed', fixedName: 'agw_emit_1' });
    const out = transformForToolTunnel(msgs, cfg, [0, 3, 4]);
    expect(out.mode).toBe('guide_wrap');
    expect(out.tools[0].function.description).toContain('世界书内容\n\n---\n\n参考图剧情');
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toEqual({ role: 'system', content: '引导系统 agw_emit_1' });
    expect(out.messages[1].role).toBe('user');
    expect(Array.isArray(out.messages[1].content)).toBe(true);
    expect(out.messages[1].content).toEqual([
      { type: 'text', text: '执行引导 agw_emit_1' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
  });
});

describe('buildStructuredPlanTool (Mode C)', () => {
  it('builds illustration schema adapting to NAI V5, nl, and lockedSize', () => {
    const res = buildStructuredPlanTool(
      { naiCharPrompts: true, nl: false, lockedSize: 'portrait', comic: false },
      1,
      3,
    );
    expect(res.toolName).toBe('submit_illustration_plan');
    const props = (res.tools[0].function.parameters as any).properties;
    const itemProps = props.images.items.properties;
    expect(itemProps.characters).toBeDefined();
    expect(itemProps.nl).toBeUndefined();
    expect(itemProps.size).toBeUndefined();
    expect(props.images.minItems).toBe(1);
    expect(props.images.maxItems).toBe(3);
  });

  it('builds comic schema when profile.comic is true', () => {
    const res = buildStructuredPlanTool(
      { naiCharPrompts: false, nl: false, lockedSize: null, comic: true },
      0,
      2,
    );
    expect(res.toolName).toBe('submit_comic_plan');
    const props = (res.tools[0].function.parameters as any).properties;
    expect(props.pages).toBeDefined();
    expect(props.changes).toBeDefined();
  });
});
