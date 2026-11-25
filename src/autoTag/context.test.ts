import { describe, expect, it } from 'vitest';
import { isWorldInfoEntrySelected, worldEntryStableKey } from './context';

describe('worldEntryStableKey & whitelist selection', () => {
  it('uses acu:<comment> for ACU generated entries regardless of uid changes', () => {
    expect(worldEntryStableKey({ uid: 42, comment: 'ACU-[女主状态]-身体状态' })).toBe(
      'acu:ACU-[女主状态]-身体状态',
    );
    expect(worldEntryStableKey({ uid: 99, comment: 'TavernDB-ACU-MainRoster' })).toBe(
      'acu:TavernDB-ACU-MainRoster',
    );
  });

  it('uses uid:<uid> for standard world info entries', () => {
    expect(worldEntryStableKey({ uid: 7, comment: '学院地图' })).toBe('uid:7');
    expect(worldEntryStableKey({ uid: 0, comment: '' })).toBe('uid:0');
  });

  it('filters entries by book and stable key in whitelist mode', () => {
    const selection = {
      mode: 'whitelist' as const,
      selectedByBook: {
        BookA: ['uid:1', 'acu:ACU-[女主]-外貌'],
      },
    };

    expect(
      isWorldInfoEntrySelected({ world: 'BookA', uid: 1, comment: '普通条目' }, selection),
    ).toBe(true);
    expect(
      isWorldInfoEntrySelected({ world: 'BookA', uid: 999, comment: 'ACU-[女主]-外貌' }, selection),
    ).toBe(true);
    expect(
      isWorldInfoEntrySelected({ world: 'BookA', uid: 2, comment: '未勾选条目' }, selection),
    ).toBe(false);
    expect(
      isWorldInfoEntrySelected({ world: 'BookB', uid: 1, comment: '未选中书' }, selection),
    ).toBe(false);
  });

  it('allows all entries in auto mode', () => {
    expect(
      isWorldInfoEntrySelected(
        { world: 'Any', uid: 5, comment: 'X' },
        { mode: 'auto', selectedByBook: {} },
      ),
    ).toBe(true);
  });
});
