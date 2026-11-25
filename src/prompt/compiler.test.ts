import { describe, expect, it } from 'vitest';
import { compilePromptPreset } from './compiler';
import { BUILTIN_PROMPT_PRESETS, resolvePromptPreset } from './presets';
import type { AutoTagCompileContext, PromptPreset } from './types';

function makeCtx(overrides: Partial<AutoTagCompileContext> = {}): AutoTagCompileContext {
  return {
    backend: 'comfyui',
    profile: {
      naiCharPrompts: false,
      nl: true,
      lockedSize: 'portrait',
      comic: false,
    },
    minImages: 0,
    maxImages: 2,
    negativeOn: true,
    charCard: '角色卡：莉莉丝是温柔的学者。',
    persona: 'User：旅行者。',
    worldInfo: '世界设定：艾尔登魔法学院。',
    bookMemory: '【前情摘要】抵达图书馆。',
    charLibrary: '【角色固定外貌库】\n莉莉丝: long silver hair, red eyes',
    slotTaskNote: '',
    historyBlock: '【前文上下文】\nAI：你们推开图书馆的大门。',
    historyTurns: [
      { role: 'user', content: '我环顾四周。' },
      { role: 'assistant', content: '书架高耸入云。' },
    ],
    targetLabel: '当前楼层正文：',
    targetText: '莉莉丝在雨夜的窗边翻开魔导书，微笑着看向你。',
    backendSpec: 'BACKEND_SPEC {{nl}}',
    protocolContract: 'PROTOCOL_CONTRACT',
    thinkingGuide: 'THINKING_GUIDE',
    charName: 'Lilith',
    userName: 'Traveler',
    floor: 12,
    readVar: k => (k === 'mood' ? 'happy' : ''),
    readGlobalVar: k => (k === 'world_style' ? 'watercolor' : ''),
    ...overrides,
  };
}

describe('compilePromptPreset', () => {
  it('compiles builtin_text_json cleanly and omits empty slots', () => {
    const preset = resolvePromptPreset('builtin_text_json', []);
    const res = compilePromptPreset(preset, makeCtx({ persona: '', slotTaskNote: '' }));

    expect(res.messages.length).toBeGreaterThanOrEqual(6);
    expect(res.messages[0].role).toBe('system');
    const last = res.messages[res.messages.length - 1];
    expect(last.role).toBe('user');
    const sysJoined = res.messages.slice(0, -1).map(m => m.content).join('\n');
    expect(sysJoined).toContain('BACKEND_SPEC');
    expect(sysJoined).toContain('nl（JSON 的 nl 键）');
    expect(sysJoined).not.toContain('User：');
    expect(last.content).toContain('【前情摘要】');
    expect(last.content).not.toContain('{{slot_task}}');
    expect(last.content).toContain('莉莉丝在雨夜的窗边翻开魔导书');
    expect(res.lintWarnings).toEqual([]);
  });

  it('strips comments, expands macros, roll, and read-only getvar/getglobalvar', () => {
    const preset: PromptPreset = {
      ...BUILTIN_PROMPT_PRESETS[0],
      id: 'macro_test',
      builtin: false,
      mergeAdjacentSameRole: false,
      mergeSystemIntoUser: false,
      entries: [
        {
          id: 'm1',
          name: 'Macro Block',
          enabled: true,
          role: 'system',
          entryType: 'normal',
          content:
            '{{// line comment}}\n//* block comment *//\nChar={{char}}, User={{user}}, Floor={{floor}}, Var={{getvar::mood}}, Global={{getglobalvar::world_style}}, Dice={{roll 6}}\n{{#nl}}NL_ACTIVE{{/nl}}{{^nl}}NL_OFF{{/nl}}',
        },
        {
          id: 't1',
          name: 'Target',
          enabled: true,
          role: 'user',
          entryType: 'slot',
          slotKind: 'target_text',
          content: '{{target_text}}',
        },
      ],
    };

    const res = compilePromptPreset(preset, makeCtx());
    expect(res.messages[0].content).not.toContain('line comment');
    expect(res.messages[0].content).not.toContain('block comment');
    expect(res.messages[0].content).toContain('Char=Lilith, User=Traveler, Floor=12, Var=happy, Global=watercolor');
    expect(res.messages[0].content).toMatch(/Dice=[1-6]/);
    expect(res.messages[0].content).toContain('NL_ACTIVE');
    expect(res.messages[0].content).not.toContain('NL_OFF');
  });

  it('does not double-expand macros inside RP target_text', () => {
    const preset = resolvePromptPreset('builtin_text_json', []);
    const res = compilePromptPreset(preset, makeCtx({ targetText: '正文里出现了字面量 {{roll 99}} 与 {{user}}。' }));
    expect(res.messages[res.messages.length - 1].content).toContain('{{roll 99}} 与 {{user}}');
  });

  it('filters entries by conditions (nl, comic, backend, slotRewrite) and OR+AND keyword triggers', () => {
    const preset: PromptPreset = {
      ...BUILTIN_PROMPT_PRESETS[0],
      id: 'cond_test',
      builtin: false,
      mergeAdjacentSameRole: false,
      mergeSystemIntoUser: false,
      entries: [
        {
          id: 'c_comic',
          name: 'Only Comic',
          enabled: true,
          role: 'system',
          entryType: 'normal',
          content: 'COMIC_ONLY',
          conditions: { comic: 'on' },
        },
        {
          id: 'c_comfy',
          name: 'Only Comfy',
          enabled: true,
          role: 'system',
          entryType: 'normal',
          content: 'COMFY_ONLY',
          conditions: { backend: 'comfyui', slotRewrite: 'exclude' },
        },
        {
          id: 'trig_hit',
          name: '雨夜Trigger',
          enabled: true,
          role: 'system',
          entryType: 'normal',
          content: 'RAIN_STYLE',
          trigger: { mode: 'keyword', orWords: ['雨夜', '雪夜'], andWords: ['魔导书'] },
        },
        {
          id: 'trig_miss',
          name: 'MissTrigger',
          enabled: true,
          role: 'system',
          entryType: 'normal',
          content: 'MISS_STYLE',
          trigger: { mode: 'keyword', orWords: ['雨夜'], andWords: ['激光剑'] },
        },
        {
          id: 'target',
          name: 'Target',
          enabled: true,
          role: 'user',
          entryType: 'slot',
          slotKind: 'target_text',
          content: '{{target_text}}',
        },
      ],
    };

    const res = compilePromptPreset(preset, makeCtx());
    const joined = res.messages.map(m => m.content).join('\n');
    expect(joined).not.toContain('COMIC_ONLY');
    expect(joined).toContain('COMFY_ONLY');
    expect(joined).toContain('RAIN_STYLE');
    expect(joined).not.toContain('MISS_STYLE');
    expect(res.stats.matchedTriggers).toEqual(['雨夜Trigger']);
  });

  it('supports history turns mode and preserves tool_guide indices across mergeAdjacentSameRole', () => {
    const preset: PromptPreset = {
      ...BUILTIN_PROMPT_PRESETS[2], // builtin_tool_guide
      entries: [
        {
          id: 'h',
          name: 'History Turns',
          enabled: true,
          role: 'user',
          entryType: 'slot',
          slotKind: 'history',
          historyMode: 'turns',
          content: '{{history}}',
        },
        {
          id: 't',
          name: 'Target',
          enabled: true,
          role: 'user',
          entryType: 'slot',
          slotKind: 'target_text',
          content: '{{target_text}}',
        },
        {
          id: 'g',
          name: '【ToolCall引导】',
          enabled: true,
          role: 'user',
          entryType: 'tool_guide',
          content: 'USE_TOOL_NOW',
        },
      ],
    };

    const res = compilePromptPreset(preset, makeCtx());
    // turn0 user, turn1 assistant, then target user (not merged with guide), then guide user
    expect(res.messages).toHaveLength(4);
    expect(res.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(res.guideIndices).toEqual([3]);
    expect(res.messages[3].content).toBe('USE_TOOL_NOW');
  });

  it('supports mergeSystemIntoUser and emits lint warnings when Mode A lacks guide', () => {
    const preset: PromptPreset = {
      ...BUILTIN_PROMPT_PRESETS[2],
      id: 'warn_test',
      mergeSystemIntoUser: true,
      mergeAdjacentSameRole: true,
      entries: [
        {
          id: 'sys',
          name: 'Sys',
          enabled: true,
          role: 'system',
          entryType: 'normal',
          content: 'SYS_NOTE',
        },
        {
          id: 'u',
          name: 'User',
          enabled: true,
          role: 'user',
          entryType: 'normal',
          content: 'NO_TARGET_SLOT',
        },
      ],
    };

    const res = compilePromptPreset(preset, makeCtx());
    expect(res.messages).toEqual([{ role: 'user', content: 'SYS_NOTE\n\nNO_TARGET_SLOT' }]);
    expect(res.lintWarnings.some(w => w.includes('ToolCall引导'))).toBe(true);
    expect(res.lintWarnings.some(w => w.includes('待生图正文'))).toBe(true);
  });
});
