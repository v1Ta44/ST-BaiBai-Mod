import { describe, expect, it } from 'vitest';
import {
  applyCleanRegexRules,
  applyForwardWordReplace,
  applyReverseWordReplace,
  applyReverseWordReplaceDeep,
  detectDangerousRegex,
  parseWordReplaceRules,
  runSafeRegex,
} from './textPreprocess';

describe('textPreprocess', () => {
  it('detects dangerous ReDoS regex patterns and rejects them safely', async () => {
    expect(detectDangerousRegex('(a+)+')).toBeTruthy();
    expect(detectDangerousRegex('([a-z]+)*$')).toBeTruthy();
    expect(detectDangerousRegex('.*something.*')).toBeTruthy();
    expect(detectDangerousRegex('<details>[\\s\\S]*?</details>')).toBeNull();

    const blocked = await runSafeRegex('aaaaaa!', '(a+)+', 'g', '');
    expect(blocked.error).toBeTruthy();
    expect(blocked.output).toBe('aaaaaa!');
  });

  it('applies safe custom clean regex rules filtered by scope', async () => {
    const rules = [
      {
        id: 'r1',
        name: '去状态栏',
        enabled: true,
        pattern: '\\[状态:[^\\]]*\\]',
        flags: 'g',
        replacement: '',
        scope: 'target' as const,
      },
      {
        id: 'r2',
        name: '禁用规则',
        enabled: false,
        pattern: '禁止删掉',
        flags: 'g',
        replacement: '',
        scope: 'both' as const,
      },
    ];

    expect(await applyCleanRegexRules('你好[状态:HP100]禁止删掉', rules, 'target')).toBe('你好禁止删掉');
    expect(await applyCleanRegexRules('你好[状态:HP100]', rules, 'history')).toBe('你好[状态:HP100]');
  });

  it('performs longest-match-first forward and reverse sensitive word replacement', () => {
    const rules = parseWordReplaceRules(`
      # comment
      // another comment
      血腥场面 = red ink scene
      血腥 = crimson
      刀刃 -> silver edge
    `);
    expect(rules).toHaveLength(3);

    const src = '她挥舞刀刃，露出血腥场面与血腥眼神。';
    const fwd = applyForwardWordReplace(src, rules);
    expect(fwd).toBe('她挥舞silver edge，露出red ink scene与crimson眼神。');

    const rev = applyReverseWordReplace(fwd, rules);
    expect(rev).toBe(src);

    const obj = applyReverseWordReplaceDeep(
      { images: [{ tag: 'holding silver edge, red ink scene', nl: 'crimson glance' }] },
      rules,
    );
    expect(obj.images[0].tag).toBe('holding 刀刃, 血腥场面');
    expect(obj.images[0].nl).toBe('血腥 glance');
  });
});
