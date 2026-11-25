import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: null as {
    extensionSettings: Record<string, unknown>;
    saveSettingsDebounced: ReturnType<typeof vi.fn>;
  } | null,
  uploadUserImage: vi.fn(),
  saveVibeFiles: vi.fn(),
  loadVibeData: vi.fn(),
}));
import { BUILTIN_NAI_ARTISTS } from '@/backends/nai';
import {
  BUILTIN_COMFY_ILLUST_ID,
  OFFICIAL_NAI_ENDPOINT_ID,
  normalizeForeignComfy,
  normalizeForeignNai,
  type ComfyUISettings,
  type NaiSettings,
} from '@/state/settings';
import { emptyCharFields, type CharTagEntry } from '@/state/charTags';
import {
  ORIGINAL_CHAR_GLOBAL_KEY,
  ORIGINAL_SETTINGS_KEY,
  itemKey,
  planImport,
  readOriginalSnapshot,
  type CurrentDataSnapshot,
} from '@/sync/baibaiImageImport';

function emptyCurrent(): CurrentDataSnapshot {
  return {
    nai: normalizeForeignNai(undefined),
    comfy: normalizeForeignComfy(undefined),
    chars: [],
  };
}

function makeChar(name: string, hair: string): CharTagEntry {
  return {
    name,
    fields: { ...emptyCharFields(), sex: '1girl', hair },
    raw: '',
    nl: '',
    source: 'manual',
    desc: '',
    history: [{ field: 'hair', from: 'black', to: hair, reason: 'old', floor: 1, at: 1 }],
  };
}

describe('baibaiImageImport pure planning', () => {
  it('两个原版键都不存在时返回 null', () => {
    expect(readOriginalSnapshot({}, emptyCurrent())).toBeNull();
    expect(readOriginalSnapshot({ baibai_mod: {} }, emptyCurrent())).toBeNull();
  });

  it('不列出 normalize 自动补出的默认服务器、默认方案、空 key 官方接入点及内置画师串/提示词', () => {
    const builtinArtist = BUILTIN_NAI_ARTISTS[0];
    const ext = {
      [ORIGINAL_SETTINGS_KEY]: {
        nai: {
          endpoints: [{ id: OFFICIAL_NAI_ENDPOINT_ID, name: 'NovelAI 官方', url: 'https://image.novelai.net', key: '', concurrency: 1 }],
          artistPresets: [builtinArtist],
          vibes: [],
          plans: [],
        },
        comfyui: {
          servers: [],
          promptSets: [{ id: BUILTIN_COMFY_ILLUST_ID, name: '内置', kind: 'illustration', spec: 'x', thinking: 'y' }],
          workflows: [],
        },
      },
    };
    const snap = readOriginalSnapshot(ext, emptyCurrent());
    expect(snap).not.toBeNull();
    expect(snap!.items).toEqual([]);
  });

  it('正确判定 new / same / conflict（排除 id / previewPath / dataPath / thumbnailPath）', () => {
    const current = emptyCurrent();
    current.nai.artistPresets.push({
      id: 'art_same',
      name: '画风A',
      prompt: 'artist:a',
      quality: '',
      negative: '',
      previewPath: '/user/images/柏宝改_画师串/art_same.jpg',
    });
    current.nai.artistPresets.push({
      id: 'art_diff',
      name: '画风B',
      prompt: 'artist:b_mod',
      quality: '',
      negative: '',
      previewPath: '/user/images/柏宝改_画师串/art_diff.jpg',
    });
    current.nai.vibes.push({
      id: 'vibe_same',
      name: 'VibeSame',
      dataPath: '/user/files/bbm-vibe-1.json',
      thumbnailPath: '/user/files/bbm-vibe-thumb-1.jpg',
      modelKeys: ['v4-5full'],
      hasImage: true,
      fingerprint: 'fp1',
      strength: 0.6,
      group: '',
    });
    current.nai.endpoints[0].key = 'same-official-key';
    current.chars.push({ ...makeChar('Alice', 'silver hair'), history: [] });
    current.chars.push({ ...makeChar('Bob', 'brown hair'), history: [] });

    const ext = {
      [ORIGINAL_SETTINGS_KEY]: {
        nai: {
          endpoints: [{ id: OFFICIAL_NAI_ENDPOINT_ID, key: 'same-official-key', concurrency: 2 }],
          artistPresets: [
            {
              id: 'art_same',
              name: '画风A',
              prompt: 'artist:a',
              quality: '',
              negative: '',
              previewPath: '/user/images/柏宝绘_画师串/art_same.jpg',
            },
            {
              id: 'art_diff',
              name: '画风B',
              prompt: 'artist:b_orig',
              quality: '',
              negative: '',
            },
            {
              id: 'art_new',
              name: '画风C',
              prompt: 'artist:c',
              quality: '',
              negative: '',
            },
          ],
          vibes: [
            {
              id: 'vibe_same',
              name: 'VibeSame',
              dataPath: '/user/files/bbi-vibe-1.json',
              thumbnailPath: '/user/files/bbi-vibe-thumb-1.jpg',
              modelKeys: ['v4-5full'],
              hasImage: true,
              fingerprint: 'fp1',
              strength: 0.6,
              group: '',
            },
          ],
          plans: [],
        },
        comfyui: { servers: [], promptSets: [], workflows: [] },
      },
      [ORIGINAL_CHAR_GLOBAL_KEY]: {
        schemaVersion: 1,
        revision: 1,
        entries: [makeChar('Alice', 'silver hair'), makeChar('Bob', 'blonde hair'), makeChar('Carol', 'red hair')],
      },
    };

    const snap = readOriginalSnapshot(ext, current)!;
    const statusOf = (kind: string, id: string) =>
      snap.items.find(i => i.kind === kind && i.id === id)?.status;

    expect(statusOf('naiEndpoint', OFFICIAL_NAI_ENDPOINT_ID)).toBe('same');
    expect(statusOf('naiArtist', 'art_same')).toBe('same');
    expect(statusOf('naiArtist', 'art_diff')).toBe('conflict');
    expect(statusOf('naiArtist', 'art_new')).toBe('new');
    expect(statusOf('naiVibe', 'vibe_same')).toBe('same');
    expect(statusOf('globalChar', 'Alice')).toBe('same');
    expect(statusOf('globalChar', 'Bob')).toBe('conflict');
    expect(statusOf('globalChar', 'Carol')).toBe('new');
    // 原版角色历史应被剥离
    expect(snap.chars.every(c => c.history.length === 0)).toBe(true);
  });

  it('选中 plan 时自动做依赖闭包，且 same 依赖直接映射不加入 autoAdded', () => {
    const current = emptyCurrent();
    current.nai.artistPresets.push({
      id: 'art_same',
      name: '已有画风',
      prompt: 'artist:same',
      quality: '',
      negative: '',
    });

    const ext = {
      [ORIGINAL_SETTINGS_KEY]: {
        nai: {
          endpoints: [
            { id: 'nep_1', name: '公益站', url: 'https://proxy.example', key: 'sk-1', concurrency: 2 },
          ],
          artistPresets: [
            { id: 'art_same', name: '已有画风', prompt: 'artist:same', quality: '', negative: '' },
          ],
          vibes: [
            {
              id: 'vibe_1',
              name: 'Vibe 1',
              dataPath: '/user/files/bbi-vibe-1.json',
              modelKeys: ['v4-5full'],
              hasImage: false,
              fingerprint: 'fp',
              strength: 0.5,
              group: '',
            },
          ],
          plans: [
            {
              id: 'plan_1',
              name: '方案1',
              endpointId: 'nep_1',
              model: 'nai-diffusion-4-5-full',
              artistId: 'art_same',
              vibeIds: ['vibe_1'],
            },
          ],
        },
      },
    };

    const snap = readOriginalSnapshot(ext, current)!;
    const plan = planImport(snap, new Set([itemKey('naiPlan', 'plan_1')]), 'copy', current);

    expect(plan.autoAdded.map(i => itemKey(i.kind, i.id))).toEqual([
      itemKey('naiEndpoint', 'nep_1'),
      itemKey('naiVibe', 'vibe_1'),
    ]);
    expect(plan.ops.map(o => itemKey(o.kind, o.sourceId))).toEqual([
      itemKey('naiEndpoint', 'nep_1'),
      itemKey('naiVibe', 'vibe_1'),
      itemKey('naiPlan', 'plan_1'),
    ]);
    expect(plan.idMap.get(itemKey('naiArtist', 'art_same'))).toBe('art_same');
  });

  it('copy 策略生成新 id、追加「（柏宝绘）」后缀，并重映射 plan/workflow 的引用', () => {
    const current = emptyCurrent();
    current.nai.endpoints.push({
      id: 'nep_1',
      name: '旧站',
      url: 'https://old.example',
      key: 'old',
      concurrency: 1,
    });
    current.nai.artistPresets.push({
      id: 'art_1',
      name: '画风1',
      prompt: 'old',
      quality: '',
      negative: '',
    });
    current.nai.plans.push({
      ...current.nai.plans[0],
      id: 'plan_1',
      name: '旧方案',
    });
    current.comfy.servers.push({ id: 'srv_1', name: '本地', url: 'http://127.0.0.1:8188' });
    current.comfy.promptSets.push({ id: 'ps_1', name: 'PS', kind: 'illustration', spec: 'old', thinking: '' });
    current.comfy.workflows.push({ ...current.comfy.workflows[0], id: 'wf_1', name: '旧WF' });

    const ext = {
      [ORIGINAL_SETTINGS_KEY]: {
        nai: {
          endpoints: [{ id: 'nep_1', name: '新站', url: 'https://new.example', key: 'new', concurrency: 2 }],
          artistPresets: [{ id: 'art_1', name: '画风1', prompt: 'new', quality: '', negative: '' }],
          vibes: [],
          plans: [
            {
              id: 'plan_1',
              name: '原版方案',
              endpointId: 'nep_1',
              model: 'nai-diffusion-5-full',
              artistId: 'art_1',
              vibeIds: [],
            },
          ],
        },
        comfyui: {
          servers: [{ id: 'srv_1', name: '新服务器', url: 'http://127.0.0.1:9000' }],
          promptSets: [{ id: 'ps_1', name: 'PS', kind: 'illustration', spec: 'new', thinking: '' }],
          workflows: [
            {
              id: 'wf_1',
              name: '原版WF',
              kind: 'illustration',
              serverId: 'srv_1',
              promptSetId: 'ps_1',
              mode: 'custom',
              workflow: '{"1":{}}',
            },
          ],
        },
      },
    };

    const snap = readOriginalSnapshot(ext, current)!;
    const selected = new Set([itemKey('naiPlan', 'plan_1'), itemKey('comfyWorkflow', 'wf_1')]);
    const plan = planImport(snap, selected, 'copy', current);

    const epOp = plan.ops.find(o => o.kind === 'naiEndpoint')!;
    const artOp = plan.ops.find(o => o.kind === 'naiArtist')!;
    const planOp = plan.ops.find(o => o.kind === 'naiPlan')!;
    const srvOp = plan.ops.find(o => o.kind === 'comfyServer')!;
    const psOp = plan.ops.find(o => o.kind === 'comfyPromptSet')!;
    const wfOp = plan.ops.find(o => o.kind === 'comfyWorkflow')!;

    expect(epOp.action).toBe('copy');
    expect(epOp.targetId).toMatch(/^nep_/);
    expect(epOp.targetId).not.toBe('nep_1');
    expect(epOp.targetName).toBe('新站（柏宝绘）');

    expect(artOp.targetId).toMatch(/^art_/);
    expect(planOp.targetId).toMatch(/^plan_/);
    expect(planOp.targetName).toBe('原版方案（柏宝绘）');

    expect(srvOp.targetId).toMatch(/^srv_/);
    expect(psOp.targetId).toMatch(/^ps_/);
    expect(wfOp.targetId).toMatch(/^wf_/);

    expect(plan.idMap.get(itemKey('naiEndpoint', 'nep_1'))).toBe(epOp.targetId);
    expect(plan.idMap.get(itemKey('naiArtist', 'art_1'))).toBe(artOp.targetId);
    expect(plan.idMap.get(itemKey('comfyServer', 'srv_1'))).toBe(srvOp.targetId);
    expect(plan.idMap.get(itemKey('comfyPromptSet', 'ps_1'))).toBe(psOp.targetId);
  });

  it('skip / overwrite 策略与官方接入点 / 全局角色特殊规则', () => {
    const current = emptyCurrent();
    current.nai.endpoints[0].key = 'mod-key';
    current.nai.artistPresets.push({ id: 'art_1', name: '旧画风', prompt: 'old', quality: '', negative: '' });
    current.chars.push({ ...makeChar('Hero', 'old hair'), history: [] });

    const ext = {
      [ORIGINAL_SETTINGS_KEY]: {
        nai: {
          endpoints: [{ id: OFFICIAL_NAI_ENDPOINT_ID, key: 'orig-key', concurrency: 1 }],
          artistPresets: [{ id: 'art_1', name: '新画风', prompt: 'new', quality: '', negative: '' }],
          vibes: [],
          plans: [],
        },
      },
      [ORIGINAL_CHAR_GLOBAL_KEY]: {
        schemaVersion: 1,
        revision: 1,
        entries: [makeChar('Hero', 'new hair')],
      },
    };

    const snap = readOriginalSnapshot(ext, current)!;
    const all = new Set(snap.items.map(i => itemKey(i.kind, i.id)));

    const skipPlan = planImport(snap, all, 'skip', current);
    expect(skipPlan.ops).toEqual([]);
    expect(skipPlan.skipped).toBe(3);
    expect(skipPlan.idMap.get(itemKey('naiArtist', 'art_1'))).toBe('art_1');

    const copyPlan = planImport(snap, all, 'copy', current);
    // 官方接入点不受 copy 影响，直接 overwrite；全局角色 copy 按 skip 处理
    expect(copyPlan.ops.find(o => o.kind === 'naiEndpoint')).toMatchObject({
      targetId: OFFICIAL_NAI_ENDPOINT_ID,
      action: 'overwrite',
    });
    expect(copyPlan.ops.find(o => o.kind === 'naiArtist')?.action).toBe('copy');
    expect(copyPlan.ops.find(o => o.kind === 'globalChar')).toBeUndefined();
    expect(copyPlan.skipped).toBe(1);

    const overwritePlan = planImport(snap, all, 'overwrite', current);
    expect(overwritePlan.ops.map(o => o.action)).toEqual(['overwrite', 'overwrite', 'overwrite']);
  });
});

describe('executeImport runtime', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.uploadUserImage.mockReset();
    mocks.saveVibeFiles.mockReset();
    mocks.loadVibeData.mockReset();
    mocks.context = {
      extensionSettings: {},
      saveSettingsDebounced: vi.fn(),
    };
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('@/st/context');
    vi.doUnmock('@/st/images');
    vi.doUnmock('@/backends/vibeStore');
  });

  it('执行导入：复制预览图、失败的 Vibe 记警告并从方案剔除、不动 channels/excludes/activeId 与原版键', async () => {
    vi.doMock('@/st/context', () => ({ getContext: () => mocks.context }));
    vi.doMock('@/st/images', () => ({
      ARTIST_PREVIEW_FOLDER: '柏宝改_画师串',
      uploadUserImage: mocks.uploadUserImage,
    }));
    vi.doMock('@/backends/vibeStore', async importOriginal => {
      const orig = await importOriginal<typeof import('@/backends/vibeStore')>();
      return {
        ...orig,
        loadVibeData: mocks.loadVibeData,
        saveVibeFiles: mocks.saveVibeFiles,
      };
    });

    const settingsMod = await import('@/state/settings');
    const globalCharMod = await import('@/state/globalCharTags');
    const importMod = await import('@/sync/baibaiImageImport');

    const origSettingsSnapshot = {
      nai: {
        endpoints: [
          { id: 'nep_orig', name: '原版站', url: 'https://orig.example', key: 'k-orig', concurrency: 2 },
        ],
        artistPresets: [
          {
            id: 'art_orig',
            name: '原版画师',
            prompt: 'artist:orig',
            quality: '',
            negative: '',
            previewPath: '/user/images/柏宝绘_画师串/art_orig.png',
          },
        ],
        vibes: [
          {
            id: 'vibe_ok',
            name: '好Vibe',
            dataPath: '/user/files/bbi-vibe-ok.json',
            thumbnailPath: '',
            modelKeys: ['v4-5full'],
            hasImage: false,
            fingerprint: 'fp_ok',
            strength: 0.7,
            group: 'G',
          },
          {
            id: 'vibe_bad',
            name: '坏Vibe',
            dataPath: '/user/files/bbi-vibe-bad.json',
            thumbnailPath: '',
            modelKeys: ['v4-5full'],
            hasImage: false,
            fingerprint: 'fp_bad',
            strength: 0.5,
            group: '',
          },
        ],
        plans: [
          {
            id: 'plan_orig',
            name: '原版方案',
            endpointId: 'nep_orig',
            model: 'nai-diffusion-4-5-full',
            artistId: 'art_orig',
            vibeIds: ['vibe_ok', 'vibe_bad'],
          },
        ],
      },
    };

    const origCharsSnapshot = {
      schemaVersion: 1,
      revision: 2,
      entries: [makeChar('全局角色', 'long blue hair')],
    };

    mocks.context!.extensionSettings = {
      baibai_mod: {
        channels: [{ id: 'ch_1', name: '已有渠道', url: 'https://llm.example/v1', key: 'sk', model: 'm' }],
        excludes: { excludedChars: ['保留排除'], excludedWorldNames: [], excludedWorldInfoPatterns: [], customStripTags: [] },
      },
      [ORIGINAL_SETTINGS_KEY]: JSON.parse(JSON.stringify(origSettingsSnapshot)),
      [ORIGINAL_CHAR_GLOBAL_KEY]: JSON.parse(JSON.stringify(origCharsSnapshot)),
    };

    await settingsMod.hydrateSettings();
    globalCharMod.initGlobalCharTags();

    const prevActivePlanId = settingsMod.settings.nai.activePlanId;
    const prevActiveWfId = settingsMod.settings.comfyui.activeWorkflowId;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        blob: async () => ({
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        }),
      })),
    );
    mocks.uploadUserImage.mockResolvedValue('/user/images/柏宝改_画师串/art_orig.png');
    mocks.loadVibeData.mockImplementation(async (vibe: { id: string }) => {
      if (vibe.id === 'vibe_bad') throw new Error('404 not found');
      return { image: '', thumbnail: '', encodings: { 'v4-5full': { encoding: 'abc', infoExtracted: 1 } } };
    });
    mocks.saveVibeFiles.mockResolvedValue({
      dataPath: '/user/files/bbm-vibe-ok.json',
      thumbnailPath: '',
    });

    const snap = importMod.readOriginalSnapshotFromHost()!;
    const selected = new Set([
      importMod.itemKey('naiPlan', 'plan_orig'),
      importMod.itemKey('globalChar', '全局角色'),
    ]);
    const plan = importMod.planImport(snap, selected, 'copy', importMod.getCurrentDataSnapshot());
    const report = await importMod.executeImport(plan);

    expect(report.counts.naiEndpoint).toBe(1);
    expect(report.counts.naiArtist).toBe(1);
    expect(report.counts.naiVibe).toBe(1);
    expect(report.counts.naiPlan).toBe(1);
    expect(report.counts.globalChar).toBe(1);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('坏Vibe');

    // 预览图被上传到 柏宝改_画师串 目录，不沿用原版路径
    expect(mocks.uploadUserImage).toHaveBeenCalledWith('柏宝改_画师串', 'art_orig', expect.any(String), 'png');
    const importedArtist = settingsMod.settings.nai.artistPresets.find(a => a.id === 'art_orig');
    expect(importedArtist?.previewPath).toBe('/user/images/柏宝改_画师串/art_orig.png');

    // 失败的 Vibe 已从导入方案的 vibeIds 剔除
    const importedPlan = settingsMod.settings.nai.plans.find(p => p.id === 'plan_orig');
    expect(importedPlan?.vibeIds).toEqual(['vibe_ok']);

    // 全局角色已写入
    expect(globalCharMod.globalCharTagLib.entries.map(e => e.name)).toEqual(['全局角色']);

    // activePlanId / activeWorkflowId / channels / excludes 未被改动
    expect(settingsMod.settings.nai.activePlanId).toBe(prevActivePlanId);
    expect(settingsMod.settings.comfyui.activeWorkflowId).toBe(prevActiveWfId);
    expect(settingsMod.settings.channels.map(c => c.id)).toEqual(['ch_1']);
    expect(settingsMod.settings.excludes.excludedChars).toEqual(['保留排除']);

    // 原版键未被写入或修改
    expect(mocks.context!.extensionSettings[ORIGINAL_SETTINGS_KEY]).toEqual(origSettingsSnapshot);
    expect(mocks.context!.extensionSettings[ORIGINAL_CHAR_GLOBAL_KEY]).toEqual(origCharsSnapshot);
  });
});
