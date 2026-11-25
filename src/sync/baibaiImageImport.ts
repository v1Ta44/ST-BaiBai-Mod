import { isBuiltinNaiArtist } from '@/backends/nai';
import { loadVibeData, saveVibeFiles, vibeMetaFromData } from '@/backends/vibeStore';
import { bytesToBase64 } from '@/base64';
import { bumpArtistPreview } from '@/pages/backend/panels/artistPreview';
import { randomUuid } from '@/randomUuid';
import { getContext } from '@/st/context';
import { ARTIST_PREVIEW_FOLDER, uploadUserImage } from '@/st/images';
import { normalizeCharTagStore, type CharTagEntry } from '@/state/charTags';
import { globalCharTagLib, upsertGlobalCharTag } from '@/state/globalCharTags';
import {
  OFFICIAL_NAI_ENDPOINT_ID,
  isBuiltinComfyPromptSet,
  normalizeForeignComfy,
  normalizeForeignNai,
  settings,
  type ComfyPromptSet,
  type ComfyServer,
  type ComfyUISettings,
  type ComfyWorkflowPreset,
  type NaiArtistPreset,
  type NaiEndpoint,
  type NaiPlan,
  type NaiSettings,
  type NaiVibe,
  type NaiVibeData,
} from '@/state/settings';

export const ORIGINAL_SETTINGS_KEY = 'baibai_image';
export const ORIGINAL_CHAR_GLOBAL_KEY = 'baibai_image_char_global';
export const ORIGINAL_VIBE_DB = 'baibai_image_vibes';
export const ORIGINAL_FOLDER_PREFIX = '柏宝绘_';
export const ORIGINAL_ARTIST_PREVIEW_FOLDER = '柏宝绘_画师串';

const FETCH_TIMEOUT_MS = 20_000;

export type ImportKind =
  | 'naiEndpoint'
  | 'naiArtist'
  | 'naiVibe'
  | 'naiPlan'
  | 'comfyServer'
  | 'comfyPromptSet'
  | 'comfyWorkflow'
  | 'globalChar';

export type ItemStatus = 'new' | 'same' | 'conflict';

export interface ImportDep {
  kind: ImportKind;
  id: string;
}

export interface ImportItem {
  kind: ImportKind;
  id: string; // globalChar 使用 name
  name: string;
  detail?: string;
  status: ItemStatus;
  deps: ImportDep[];
}

export interface OriginalSnapshot {
  nai: NaiSettings;
  comfy: ComfyUISettings;
  chars: CharTagEntry[];
  items: ImportItem[];
}

export type ConflictStrategy = 'skip' | 'overwrite' | 'copy';

export interface CurrentDataSnapshot {
  nai: NaiSettings;
  comfy: ComfyUISettings;
  chars: CharTagEntry[];
}

export type PlannedAction = 'add' | 'overwrite' | 'copy' | 'skip';

export interface PlannedOp {
  kind: ImportKind;
  sourceId: string;
  targetId: string;
  targetName: string;
  action: PlannedAction;
  status: ItemStatus;
}

export interface ImportPlan {
  snapshot: OriginalSnapshot;
  strategy: ConflictStrategy;
  ops: PlannedOp[];
  idMap: Map<string, string>;
  autoAdded: ImportItem[];
  skipped: number;
}

export interface ImportReport {
  counts: Record<ImportKind, number>;
  skipped: number;
  warnings: string[];
}

export function itemKey(kind: ImportKind, id: string): string {
  return `${kind}:${id}`;
}

function emptyCounts(): Record<ImportKind, number> {
  return {
    naiEndpoint: 0,
    naiArtist: 0,
    naiVibe: 0,
    naiPlan: 0,
    comfyServer: 0,
    comfyPromptSet: 0,
    comfyWorkflow: 0,
    globalChar: 0,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function extractRawIds(arr: unknown): Set<string> | null {
  if (!Array.isArray(arr)) return null;
  const ids = new Set<string>();
  for (const item of arr) {
    if (isPlainObject(item) && typeof item.id === 'string' && item.id) {
      ids.add(item.id);
    }
  }
  return ids;
}

/* ============ 内容比对（排除 id / previewPath / dataPath / thumbnailPath） ============ */

function endpointContentKey(e: NaiEndpoint): string {
  if (e.id === OFFICIAL_NAI_ENDPOINT_ID) {
    return JSON.stringify({ key: e.key });
  }
  return JSON.stringify({
    name: e.name,
    url: e.url,
    key: e.key,
    concurrency: e.concurrency,
  });
}

function artistContentKey(a: NaiArtistPreset): string {
  return JSON.stringify({
    name: a.name,
    prompt: a.prompt,
    quality: a.quality,
    negative: a.negative,
  });
}

function vibeContentKey(v: NaiVibe): string {
  return JSON.stringify({
    name: v.name,
    modelKeys: [...v.modelKeys].sort(),
    hasImage: v.hasImage,
    fingerprint: v.fingerprint,
    strength: v.strength,
    group: v.group,
  });
}

function naiPlanContentKey(p: NaiPlan): string {
  return JSON.stringify({
    name: p.name,
    endpointId: p.endpointId,
    model: p.model,
    artistId: p.artistId,
    qualityTags: p.qualityTags,
    undesiredContent: p.undesiredContent,
    sampler: p.sampler,
    steps: p.steps,
    scale: p.scale,
    cfgRescale: p.cfgRescale,
    noiseSchedule: p.noiseSchedule,
    seed: p.seed,
    varietyBoost: p.varietyBoost,
    normalizeRefStrength: p.normalizeRefStrength,
    vibeIds: p.vibeIds,
    naturalLanguage: p.naturalLanguage,
    orientationLock: p.orientationLock,
    portraitSize: p.portraitSize,
    landscapeSize: p.landscapeSize,
  });
}

function comfyServerContentKey(s: ComfyServer): string {
  return JSON.stringify({
    name: s.name,
    url: s.url,
  });
}

function comfyPromptSetContentKey(p: ComfyPromptSet): string {
  return JSON.stringify({
    name: p.name,
    kind: p.kind,
    spec: p.spec,
    thinking: p.thinking,
  });
}

function comfyWorkflowContentKey(w: ComfyWorkflowPreset): string {
  return JSON.stringify({
    name: w.name,
    kind: w.kind,
    serverId: w.serverId,
    promptSetId: w.promptSetId,
    mode: w.mode,
    workflow: w.workflow,
    simple: w.simple,
    naturalLanguage: w.naturalLanguage,
    portraitSize: w.portraitSize,
    landscapeSize: w.landscapeSize,
    orientationLock: w.orientationLock,
    promptPresetId: w.promptPresetId ?? '',
  });
}

function globalCharContentKey(c: CharTagEntry): string {
  return JSON.stringify({
    name: c.name,
    fields: c.fields,
    raw: c.raw,
    nl: c.nl,
    source: c.source,
    desc: c.desc,
  });
}

function compareStatus<T>(
  candidate: T,
  existing: T | undefined,
  keyOf: (item: T) => string,
): ItemStatus {
  if (!existing) return 'new';
  return keyOf(candidate) === keyOf(existing) ? 'same' : 'conflict';
}

/* ============ 快照读取（纯函数） ============ */

export function readOriginalSnapshot(
  ext: Record<string, unknown>,
  current: CurrentDataSnapshot,
): OriginalSnapshot | null {
  const rawSettings = isPlainObject(ext[ORIGINAL_SETTINGS_KEY]) ? ext[ORIGINAL_SETTINGS_KEY] : null;
  const rawCharStore = isPlainObject(ext[ORIGINAL_CHAR_GLOBAL_KEY]) ? ext[ORIGINAL_CHAR_GLOBAL_KEY] : null;
  if (!rawSettings && !rawCharStore) return null;

  const rawNai = rawSettings && isPlainObject(rawSettings.nai) ? rawSettings.nai : null;
  const rawComfy = rawSettings && isPlainObject(rawSettings.comfyui) ? rawSettings.comfyui : null;

  const nai = normalizeForeignNai(rawNai);
  const comfy = normalizeForeignComfy(rawComfy);

  const rawCharsEntries = rawCharStore && Array.isArray(rawCharStore.entries) ? rawCharStore.entries : [];
  const chars = rawCharsEntries.length
    ? normalizeCharTagStore({ version: 3, entries: rawCharsEntries }).map(entry => ({ ...entry, history: [] }))
    : [];

  const items: ImportItem[] = [];

  if (rawNai) {
    const rawEndpointIds = extractRawIds(rawNai.endpoints);
    const hasEndpointArray = rawEndpointIds !== null;
    const rawEndpointCount = Array.isArray(rawNai.endpoints) ? rawNai.endpoints.length : 0;

    // 接入点
    const currEndpoints = new Map(current.nai.endpoints.map(e => [e.id, e]));
    const listedEndpoints = nai.endpoints.filter(ep => {
      if (ep.id === OFFICIAL_NAI_ENDPOINT_ID) {
        return ep.key.trim() !== '';
      }
      if (hasEndpointArray) {
        return rawEndpointIds.has(ep.id) || (rawEndpointCount > 0 && ep.id.startsWith('nep_'));
      }
      // 极旧平铺版本：只有填了第三方 url 才会折出 nep_legacy
      return typeof rawNai.url === 'string' && rawNai.url.trim() !== '';
    });
    for (const ep of listedEndpoints) {
      items.push({
        kind: 'naiEndpoint',
        id: ep.id,
        name: ep.name,
        detail: ep.url,
        status: compareStatus(ep, currEndpoints.get(ep.id), endpointContentKey),
        deps: [],
      });
    }

    // 画师串（不列内置条目）
    const currArtists = new Map(current.nai.artistPresets.map(a => [a.id, a]));
    const rawArtistIds = extractRawIds(rawNai.artistPresets);
    const listedArtists = nai.artistPresets.filter(a => {
      if (isBuiltinNaiArtist(a.id)) return false;
      if (rawArtistIds) return rawArtistIds.has(a.id);
      return true;
    });
    for (const art of listedArtists) {
      items.push({
        kind: 'naiArtist',
        id: art.id,
        name: art.name,
        detail: art.previewPath ? '含预览图' : undefined,
        status: compareStatus(art, currArtists.get(art.id), artistContentKey),
        deps: [],
      });
    }

    // Vibe
    const currVibes = new Map(current.nai.vibes.map(v => [v.id, v]));
    const rawVibeIds = extractRawIds(rawNai.vibes);
    const listedVibes = nai.vibes.filter(v => (rawVibeIds ? rawVibeIds.has(v.id) : true));
    for (const vibe of listedVibes) {
      items.push({
        kind: 'naiVibe',
        id: vibe.id,
        name: vibe.name,
        detail: vibe.group || undefined,
        status: compareStatus(vibe, currVibes.get(vibe.id), vibeContentKey),
        deps: [],
      });
    }

    // NAI 出图方案
    const currPlans = new Map(current.nai.plans.map(p => [p.id, p]));
    const rawPlanIds = extractRawIds(rawNai.plans);
    const hasLegacyNaiFields = !rawPlanIds && Object.keys(rawNai).length > 0;
    const listedPlans = nai.plans.filter(p => {
      if (rawPlanIds) return rawPlanIds.has(p.id);
      return hasLegacyNaiFields;
    });
    const availableKeys = new Set(items.map(it => itemKey(it.kind, it.id)));
    for (const plan of listedPlans) {
      const deps: ImportDep[] = [];
      if (
        plan.endpointId &&
        plan.endpointId !== OFFICIAL_NAI_ENDPOINT_ID &&
        availableKeys.has(itemKey('naiEndpoint', plan.endpointId))
      ) {
        deps.push({ kind: 'naiEndpoint', id: plan.endpointId });
      }
      if (
        plan.artistId &&
        !isBuiltinNaiArtist(plan.artistId) &&
        availableKeys.has(itemKey('naiArtist', plan.artistId))
      ) {
        deps.push({ kind: 'naiArtist', id: plan.artistId });
      }
      for (const vid of plan.vibeIds) {
        if (availableKeys.has(itemKey('naiVibe', vid))) {
          deps.push({ kind: 'naiVibe', id: vid });
        }
      }
      items.push({
        kind: 'naiPlan',
        id: plan.id,
        name: plan.name,
        detail: plan.model,
        status: compareStatus(plan, currPlans.get(plan.id), naiPlanContentKey),
        deps,
      });
    }
  }

  if (rawComfy) {
    // ComfyUI 服务器
    const currServers = new Map(current.comfy.servers.map(s => [s.id, s]));
    const rawServerIds = extractRawIds(rawComfy.servers);
    const hasLegacyComfyServer = !rawServerIds && Object.keys(rawComfy).length > 0;
    const listedServers = comfy.servers.filter(s => {
      if (rawServerIds) return rawServerIds.has(s.id);
      return hasLegacyComfyServer;
    });
    for (const srv of listedServers) {
      items.push({
        kind: 'comfyServer',
        id: srv.id,
        name: srv.name,
        detail: srv.url,
        status: compareStatus(srv, currServers.get(srv.id), comfyServerContentKey),
        deps: [],
      });
    }

    // ComfyUI 提示词（不列内置条目）
    const currPromptSets = new Map(current.comfy.promptSets.map(p => [p.id, p]));
    const rawPromptSetIds = extractRawIds(rawComfy.promptSets);
    const listedPromptSets = comfy.promptSets.filter(p => {
      if (isBuiltinComfyPromptSet(p.id)) return false;
      if (rawPromptSetIds) return rawPromptSetIds.has(p.id);
      return true;
    });
    for (const ps of listedPromptSets) {
      items.push({
        kind: 'comfyPromptSet',
        id: ps.id,
        name: ps.name,
        detail: ps.kind === 'comic' ? '漫画' : '插画',
        status: compareStatus(ps, currPromptSets.get(ps.id), comfyPromptSetContentKey),
        deps: [],
      });
    }

    // ComfyUI 工作流方案
    const currWorkflows = new Map(current.comfy.workflows.map(w => [w.id, w]));
    const rawWorkflowIds = extractRawIds(rawComfy.workflows);
    const hasLegacyComfyWorkflow = !rawWorkflowIds && Object.keys(rawComfy).length > 0;
    const listedWorkflows = comfy.workflows.filter(w => {
      if (rawWorkflowIds) return rawWorkflowIds.has(w.id);
      return hasLegacyComfyWorkflow;
    });
    const availableKeys = new Set(items.map(it => itemKey(it.kind, it.id)));
    for (const wf of listedWorkflows) {
      const deps: ImportDep[] = [];
      if (wf.serverId && availableKeys.has(itemKey('comfyServer', wf.serverId))) {
        deps.push({ kind: 'comfyServer', id: wf.serverId });
      }
      if (
        wf.promptSetId &&
        !isBuiltinComfyPromptSet(wf.promptSetId) &&
        availableKeys.has(itemKey('comfyPromptSet', wf.promptSetId))
      ) {
        deps.push({ kind: 'comfyPromptSet', id: wf.promptSetId });
      }
      items.push({
        kind: 'comfyWorkflow',
        id: wf.id,
        name: wf.name,
        detail: wf.kind === 'comic' ? '漫画' : '插画',
        status: compareStatus(wf, currWorkflows.get(wf.id), comfyWorkflowContentKey),
        deps,
      });
    }
  }

  // 全局角色库（按 name 匹配）
  const currChars = new Map(current.chars.map(c => [c.name, c]));
  for (const ch of chars) {
    items.push({
      kind: 'globalChar',
      id: ch.name,
      name: ch.name,
      status: compareStatus(ch, currChars.get(ch.name), globalCharContentKey),
      deps: [],
    });
  }

  return { nai, comfy, chars, items };
}

/* ============ 导入规划（纯函数） ============ */

const EXECUTION_ORDER: readonly ImportKind[] = [
  'naiEndpoint',
  'naiArtist',
  'naiVibe',
  'naiPlan',
  'comfyServer',
  'comfyPromptSet',
  'comfyWorkflow',
  'globalChar',
];

const COPY_ID_PREFIX: Record<Exclude<ImportKind, 'globalChar'>, string> = {
  naiEndpoint: 'nep_',
  naiArtist: 'art_',
  naiVibe: 'vibe_',
  naiPlan: 'plan_',
  comfyServer: 'srv_',
  comfyPromptSet: 'ps_',
  comfyWorkflow: 'wf_',
};

function collectExistingIds(current: CurrentDataSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const e of current.nai.endpoints) ids.add(e.id);
  for (const a of current.nai.artistPresets) ids.add(a.id);
  for (const v of current.nai.vibes) ids.add(v.id);
  for (const p of current.nai.plans) ids.add(p.id);
  for (const s of current.comfy.servers) ids.add(s.id);
  for (const p of current.comfy.promptSets) ids.add(p.id);
  for (const w of current.comfy.workflows) ids.add(w.id);
  return ids;
}

function makeFreshId(kind: Exclude<ImportKind, 'globalChar'>, taken: Set<string>): string {
  const prefix = COPY_ID_PREFIX[kind];
  let id = '';
  do {
    id = `${prefix}${Date.now()}_${randomUuid().slice(0, 8)}`;
  } while (taken.has(id));
  taken.add(id);
  return id;
}

function resolveAction(item: ImportItem, strategy: ConflictStrategy): PlannedAction {
  if (item.status === 'same') return 'skip';
  if (item.status === 'new') return 'add';
  // conflict
  if (item.kind === 'naiEndpoint' && item.id === OFFICIAL_NAI_ENDPOINT_ID) {
    // 官方接入点固定 id，不建副本
    return strategy === 'skip' ? 'skip' : 'overwrite';
  }
  if (item.kind === 'globalChar') {
    // 全局角色按名字匹配，无副本选项
    return strategy === 'overwrite' ? 'overwrite' : 'skip';
  }
  return strategy;
}

export function planImport(
  snapshot: OriginalSnapshot,
  selectedKeys: Set<string>,
  strategy: ConflictStrategy,
  current: CurrentDataSnapshot,
): ImportPlan {
  const itemByKey = new Map(snapshot.items.map(it => [itemKey(it.kind, it.id), it]));
  const idMap = new Map<string, string>();
  const effectiveKeys = new Set<string>();
  const autoAdded: ImportItem[] = [];
  const autoAddedKeys = new Set<string>();

  // 1. 依赖闭包：status === 'same' 的依赖直接映射到本项目已有 id，其余自动加入
  const queue: string[] = [];
  for (const key of selectedKeys) {
    const item = itemByKey.get(key);
    if (!item) continue;
    effectiveKeys.add(key);
    queue.push(key);
  }

  while (queue.length > 0) {
    const key = queue.shift()!;
    const item = itemByKey.get(key);
    if (!item) continue;
    for (const dep of item.deps) {
      const dKey = itemKey(dep.kind, dep.id);
      const depItem = itemByKey.get(dKey);
      if (!depItem) continue;
      if (depItem.status === 'same') {
        idMap.set(dKey, depItem.id);
        continue;
      }
      if (!effectiveKeys.has(dKey)) {
        effectiveKeys.add(dKey);
        queue.push(dKey);
        if (!selectedKeys.has(dKey) && !autoAddedKeys.has(dKey)) {
          autoAddedKeys.add(dKey);
          autoAdded.push(depItem);
        }
      }
    }
  }

  // 2. 按依赖拓扑顺序生成 ops 与 idMap
  const takenIds = collectExistingIds(current);
  const ops: PlannedOp[] = [];
  let skipped = 0;

  for (const kind of EXECUTION_ORDER) {
    for (const item of snapshot.items) {
      if (item.kind !== kind) continue;
      const key = itemKey(item.kind, item.id);
      if (!effectiveKeys.has(key)) continue;

      const action = resolveAction(item, strategy);
      if (action === 'skip') {
        idMap.set(key, item.id);
        skipped += 1;
        continue;
      }

      if (action === 'copy' && item.kind !== 'globalChar') {
        const newId = makeFreshId(item.kind, takenIds);
        idMap.set(key, newId);
        ops.push({
          kind: item.kind,
          sourceId: item.id,
          targetId: newId,
          targetName: `${item.name}（柏宝绘）`,
          action,
          status: item.status,
        });
      } else {
        idMap.set(key, item.id);
        ops.push({
          kind: item.kind,
          sourceId: item.id,
          targetId: item.id,
          targetName: item.name,
          action,
          status: item.status,
        });
      }
    }
  }

  // 如果某条依赖是 autoAdded 但按当前策略最终被 skip（例如 conflict + skip），从 autoAdded 剔除以免误导
  const opKeys = new Set(ops.map(op => itemKey(op.kind, op.sourceId)));
  const activeAutoAdded = autoAdded.filter(it => opKeys.has(itemKey(it.kind, it.id)));

  return {
    snapshot,
    strategy,
    ops,
    idMap,
    autoAdded: activeAutoAdded,
    skipped,
  };
}

/* ============ 运行时 IO helpers ============ */

export function getCurrentDataSnapshot(): CurrentDataSnapshot {
  return {
    nai: settings.nai,
    comfy: settings.comfyui,
    chars: globalCharTagLib.entries,
  };
}

export function readOriginalSnapshotFromHost(): OriginalSnapshot | null {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return null;
  return readOriginalSnapshot(ctx.extensionSettings, getCurrentDataSnapshot());
}

async function readOriginalIdbVibe(key: string): Promise<NaiVibeData> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('当前浏览器不支持 IndexedDB');
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(ORIGINAL_VIBE_DB, 1);
    request.onupgradeneeded = () => {
      // 只读读取原版库：禁止新建空库或 empty objectStore
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('原版 Vibe 本地数据库不存在或无法打开'));
    request.onblocked = () => reject(new Error('原版 Vibe 本地数据库被占用'));
  });
  try {
    if (!db.objectStoreNames.contains('vibes')) {
      throw new Error('原版 Vibe 本地存储中没有 vibes 数据');
    }
    return await new Promise<NaiVibeData>((resolve, reject) => {
      const req = db.transaction('vibes', 'readonly').objectStore('vibes').get(key);
      req.onsuccess = () => {
        const data = req.result as Partial<NaiVibeData> | undefined;
        if (!data || typeof data !== 'object' || !data.encodings || typeof data.encodings !== 'object') {
          reject(new Error('原版 Vibe 本地数据不存在或格式无效'));
          return;
        }
        resolve({
          image: typeof data.image === 'string' ? data.image : '',
          thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : '',
          encodings: data.encodings,
        });
      };
      req.onerror = () => reject(req.error ?? new Error('读取原版 Vibe 本地数据失败'));
    });
  } finally {
    db.close();
  }
}

async function copyArtistPreview(previewPath: string, targetId: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(previewPath, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length) throw new Error('预览图文件为空');
    const ext = previewPath.split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || 'jpg';
    const uploadedPath = await uploadUserImage(ARTIST_PREVIEW_FOLDER, targetId, bytesToBase64(bytes), ext);
    bumpArtistPreview(targetId);
    return uploadedPath;
  } finally {
    clearTimeout(timer);
  }
}

function upsertById<T extends { id: string }>(list: T[], next: T, action: PlannedAction): void {
  if (action === 'overwrite') {
    const idx = list.findIndex(item => item.id === next.id);
    if (idx >= 0) {
      list[idx] = next;
      return;
    }
  }
  list.push(next);
}

/* ============ 执行导入 ============ */

export async function executeImport(plan: ImportPlan): Promise<ImportReport> {
  const counts = emptyCounts();
  let skipped = plan.skipped;
  const warnings: string[] = [];

  const { snapshot, idMap } = plan;
  const endpointById = new Map(snapshot.nai.endpoints.map(e => [e.id, e]));
  const artistById = new Map(snapshot.nai.artistPresets.map(a => [a.id, a]));
  const vibeById = new Map(snapshot.nai.vibes.map(v => [v.id, v]));
  const planById = new Map(snapshot.nai.plans.map(p => [p.id, p]));
  const serverById = new Map(snapshot.comfy.servers.map(s => [s.id, s]));
  const promptSetById = new Map(snapshot.comfy.promptSets.map(p => [p.id, p]));
  const workflowById = new Map(snapshot.comfy.workflows.map(w => [w.id, w]));
  const charByName = new Map(snapshot.chars.map(c => [c.name, c]));

  const failedVibeTargetIds = new Set<string>();

  for (const op of plan.ops) {
    if (op.action === 'skip') continue;

    switch (op.kind) {
      case 'naiEndpoint': {
        const src = endpointById.get(op.sourceId);
        if (!src) break;
        if (op.sourceId === OFFICIAL_NAI_ENDPOINT_ID) {
          const official = settings.nai.endpoints.find(e => e.id === OFFICIAL_NAI_ENDPOINT_ID);
          if (official) {
            official.key = src.key;
            counts.naiEndpoint += 1;
          }
          break;
        }
        upsertById(
          settings.nai.endpoints,
          { ...src, id: op.targetId, name: op.targetName },
          op.action,
        );
        counts.naiEndpoint += 1;
        break;
      }

      case 'naiArtist': {
        const src = artistById.get(op.sourceId);
        if (!src) break;
        let previewPath: string | undefined;
        if (src.previewPath) {
          try {
            previewPath = await copyArtistPreview(src.previewPath, op.targetId);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            warnings.push(`画师串「${op.targetName}」预览图复制失败（已跳过预览图）：${msg}`);
          }
        }
        upsertById(
          settings.nai.artistPresets,
          {
            id: op.targetId,
            name: op.targetName,
            prompt: src.prompt,
            quality: src.quality,
            negative: src.negative,
            ...(previewPath ? { previewPath } : {}),
          },
          op.action,
        );
        counts.naiArtist += 1;
        break;
      }

      case 'naiVibe': {
        const src = vibeById.get(op.sourceId);
        if (!src) break;
        try {
          const data = src.dataPath.startsWith('idb:')
            ? await readOriginalIdbVibe(src.dataPath.slice(4))
            : await loadVibeData(src);
          const paths = await saveVibeFiles(data, null, op.targetId);
          const meta = vibeMetaFromData(
            op.targetId,
            op.targetName,
            paths.dataPath,
            paths.thumbnailPath,
            data,
            src.strength,
            src.group,
          );
          upsertById(settings.nai.vibes, meta, op.action);
          counts.naiVibe += 1;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          warnings.push(`Vibe「${op.targetName}」导入失败（已跳过）：${msg}`);
          failedVibeTargetIds.add(op.targetId);
          skipped += 1;
        }
        break;
      }

      case 'naiPlan': {
        const src = planById.get(op.sourceId);
        if (!src) break;
        const mappedEndpointId =
          src.endpointId === OFFICIAL_NAI_ENDPOINT_ID
            ? OFFICIAL_NAI_ENDPOINT_ID
            : (idMap.get(itemKey('naiEndpoint', src.endpointId)) ?? src.endpointId);
        const mappedArtistId =
          !src.artistId || isBuiltinNaiArtist(src.artistId)
            ? src.artistId
            : (idMap.get(itemKey('naiArtist', src.artistId)) ?? src.artistId);
        const mappedVibeIds = src.vibeIds
          .map(vid => idMap.get(itemKey('naiVibe', vid)) ?? vid)
          .filter(vid => !failedVibeTargetIds.has(vid));

        upsertById(
          settings.nai.plans,
          {
            ...src,
            id: op.targetId,
            name: op.targetName,
            endpointId: mappedEndpointId,
            artistId: mappedArtistId,
            vibeIds: Array.from(new Set(mappedVibeIds)),
          },
          op.action,
        );
        counts.naiPlan += 1;
        break;
      }

      case 'comfyServer': {
        const src = serverById.get(op.sourceId);
        if (!src) break;
        upsertById(
          settings.comfyui.servers,
          { ...src, id: op.targetId, name: op.targetName },
          op.action,
        );
        counts.comfyServer += 1;
        break;
      }

      case 'comfyPromptSet': {
        const src = promptSetById.get(op.sourceId);
        if (!src) break;
        upsertById(
          settings.comfyui.promptSets,
          { ...src, id: op.targetId, name: op.targetName },
          op.action,
        );
        counts.comfyPromptSet += 1;
        break;
      }

      case 'comfyWorkflow': {
        const src = workflowById.get(op.sourceId);
        if (!src) break;
        const mappedServerId = idMap.get(itemKey('comfyServer', src.serverId)) ?? src.serverId;
        const mappedPromptSetId =
          !src.promptSetId || isBuiltinComfyPromptSet(src.promptSetId)
            ? src.promptSetId
            : (idMap.get(itemKey('comfyPromptSet', src.promptSetId)) ?? src.promptSetId);

        upsertById(
          settings.comfyui.workflows,
          {
            ...src,
            id: op.targetId,
            name: op.targetName,
            serverId: mappedServerId,
            promptSetId: mappedPromptSetId,
            simple: JSON.parse(JSON.stringify(src.simple)),
          },
          op.action,
        );
        counts.comfyWorkflow += 1;
        break;
      }

      case 'globalChar': {
        const src = charByName.get(op.sourceId);
        if (!src) break;
        const ok = upsertGlobalCharTag({
          ...src,
          fields: { ...src.fields },
          history: [],
        });
        if (ok) {
          counts.globalChar += 1;
        } else {
          warnings.push(`角色「${op.targetName}」内容为空，未导入`);
          skipped += 1;
        }
        break;
      }
    }
  }

  return { counts, skipped, warnings };
}
