import { describe, expect, it } from 'vitest';
import { exportPromptPresetJson, importPromptPresetJson } from './chatu8Import';
import { BUILTIN_PROMPT_PRESETS } from './presets';

describe('chatu8Import', () => {
  it('round-trips native preset desensitized export and import', () => {
    const exported = exportPromptPresetJson(BUILTIN_PROMPT_PRESETS[2]);
    expect(exported).toContain('st-baibai-mod-prompt-v1');
    expect(exported).not.toContain('sk-');

    const imported = importPromptPresetJson(exported);
    expect(imported).toHaveLength(1);
    expect(imported[0].builtin).toBe(false);
    expect(imported[0].outputMode).toBe('tool_tunnel');
    expect(imported[0].toolCall.guideWrap).toBe(true);
    expect(imported[0].entries.length).toBe(BUILTIN_PROMPT_PRESETS[2].entries.length);
  });

  it('imports st-chatu8 test_context_profiles with Chinese macros, triggers, and ToolCall guide', () => {
    const chatu8Raw = JSON.stringify({
      test_context_profiles: [
        {
          name: '智绘姬预设迁移版',
          entries: [
            {
              name: '系统引导',
              role: 'system',
              enabled: true,
              content: '角色信息：\n{{角色卡}}\n世界书如下：',
            },
            {
              name: '世界书槽位',
              role: 'system',
              enabled: true,
              content: '{{世界书触发}}',
            },
            {
              name: '夜战触发',
              role: 'system',
              enabled: true,
              triggerMode: 'keyword',
              triggerWords: ['夜晚', '月光'],
              andTriggerWords: '拔剑, 战斗',
              content: 'night battle cinematic lighting',
            },
            {
              name: '上下文与正文',
              role: 'user',
              enabled: true,
              content: '{{上下文}}\n---\n{{正文}}',
            },
            {
              name: '【ToolCall引导】提交绘图',
              role: 'user',
              enabled: true,
              content: '请调用工具输出 thoughts 与 output',
            },
          ],
        },
      ],
    });

    const imported = importPromptPresetJson(chatu8Raw);
    expect(imported).toHaveLength(1);
    const preset = imported[0];
    expect(preset.name).toBe('智绘姬预设迁移版');
    expect(preset.outputMode).toBe('tool_tunnel');
    expect(preset.toolCall.guideWrap).toBe(true);

    expect(preset.entries[0].content).toContain('{{char_card}}');
    expect(preset.entries[1].entryType).toBe('slot');
    expect(preset.entries[1].slotKind).toBe('world_info');
    expect(preset.entries[2].trigger).toEqual({
      mode: 'keyword',
      orWords: ['夜晚', '月光'],
      andWords: ['拔剑', '战斗'],
    });
    expect(preset.entries[3].content).toBe('{{history}}\n---\n{{target_text}}');
    expect(preset.entries[4].entryType).toBe('tool_guide');
  });
});
