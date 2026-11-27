import { h, render, watch, type VNode } from 'vue';

import Card from '@/floor/Card.vue';
import { clearAutoGenerateFlags } from '@/floor/autoGenerate';
import { cardStyleSheet, cardStyleTextFallback } from '@/floor/cardStyles';
import { onChatMutation } from '@/floor/chatObserver';
import { setNaiConcurrency } from '@/floor/genQueue';
import { clearAllGen, pruneGenSlots } from '@/floor/genState';
import { clearAllTagPlans } from '@/floor/tagPlanState';
import { collectFloorIframes, resolveFloorAnchors } from '@/floor/penetrate';
import { SlotRegistry } from '@/floor/registry';
import { checkSlotHealth, floorIdOf } from '@/floor/slotHealth';
import { historyEntries, latestStaleEntry, promptHash, readStore } from '@/floor/storage';
import { getContext, type STContext } from '@/st/context';
import {
  hasImageTagTrace,
  imageTagKind,
  parseImageTagContent,
  parseImageTags,
} from '@/st/imageTagRegex';
import { settings } from '@/state/settings';

/**
 * 楼层水合框架（DESIGN-FLOOR-UI.md §5.2 / §6）。
 *
 * 渲染事件触发 → 定位楼层 .mes_text → 锚点列表（DOM 顺序）与
 * parseImageTags(message.mes) 解析出的 tag 列表按序一一配对 → 每个锚点
 * 挂载一张卡片。锚点每次渲染重建，水合每次事件重建，全程幂等。
 *
 * 卡片渲进锚点自己的 **shadow root**（不是锚点本身）：楼层在 ST 的 light DOM 里，
 * ST 全局样式与用户装的美化主题会直接改到卡片上。shadow 边界双向隔离，
 * 与 index.ts 主窗口同构，只是从「一个大 host」变成「每槽位一个小 host」。
 *
 * 【两层触发,缺一不可】
 * 1. 事件层(bindFloorHydration):ST 的渲染事件,覆盖正常路径,便宜且及时;
 * 2. 自愈层(bindSlotSelfHealing):MutationObserver 兜住**不发事件**的路径。
 *
 * 第 2 层不是防御第三方插件,首先是防御 ST 自己:updateMessageBlock 直接
 * `.mes_text.html(...)` 且不发任何事件,messageEditCancel/Done 用 `.empty()`,
 * 右滑生成写 `.mes_text.html('...')`。锚点活在 .mes_text **里面**,这些路径一律
 * 把它连同 shadow root 一起删掉,而事件层对此完全无感。用户报的
 * 「图在生成、楼层里看不到界面」就是它——genState 是模块级的,卡片死了生成照样跑完。
 */

export const slotRegistry = new SlotRegistry();

let bound = false;
let healingBound = false;

/**
 * 可继承的排版属性——shadow DOM 不隔离继承，这些会透过 host 从 ST 漏进来。
 */
const CARD_INHERITED_RESET: Record<string, string> = {
  'font-style': 'normal',
  'font-weight': '400',
  'font-variant': 'normal',
  'letter-spacing': 'normal',
  'word-spacing': 'normal',
  'text-align': 'left',
  'text-transform': 'none',
  'text-indent': '0',
  'text-shadow': 'none',
  'white-space': 'normal',
  'line-height': '1.6',
  direction: 'ltr',
};

/**
 * 宿主 CSS 护甲：防止正文美化 `div:empty { display:none }`、横排 flex 压缩或高度裁切把卡片隐藏。
 */
const CARD_HOST_ARMOR: Record<string, string> = {
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  position: 'relative',
  float: 'none',
  clear: 'both',
  width: '100%',
  'max-width': '100%',
  'min-width': '0',
  height: 'auto',
  'min-height': '0',
  'max-height': 'none',
  margin: '8px 0',
  padding: '0',
  border: '0',
  background: 'transparent',
  overflow: 'visible',
  clip: 'auto',
  'clip-path': 'none',
  transform: 'none',
  'pointer-events': 'auto',
  'box-sizing': 'border-box',
  flex: '0 0 auto',
  'align-self': 'stretch',
  'font-size': '13px',
};

const SMART_THEME_VARS = [
  '--SmartThemeBlurTintColor',
  '--SmartThemeChatTintColor',
  '--SmartThemeBodyColor',
  '--SmartThemeQuoteColor',
  '--SmartThemeBorderColor',
  '--SmartThemeShadowColor',
] as const;

function syncHostThemeVars(anchor: HTMLElement): void {
  try {
    const rootStyle = getComputedStyle(document.documentElement);
    for (const name of SMART_THEME_VARS) {
      const val = rootStyle.getPropertyValue(name).trim();
      if (val) anchor.style.setProperty(name, val);
    }
  } catch {
    // 忽略无样式环境
  }
}

function injectFallbackStyle(shadow: ShadowRoot, doc: Document): void {
  const style = doc.createElement('style');
  style.textContent = cardStyleTextFallback();
  shadow.appendChild(style);
}

/**
 * 备好锚点的 shadow root:挂样式 + 钉死继承属性与宿主护甲(幂等)。
 * 锚点每次楼层渲染都是新元素,但 MESSAGE_UPDATED 等事件下也可能复用同一元素,
 * 故 attachShadow 前先查 shadowRoot——重复 attach 会抛。
 */
function ensureShadow(anchor: HTMLElement): ShadowRoot {
  for (const [prop, value] of Object.entries(CARD_INHERITED_RESET)) {
    anchor.style.setProperty(prop, value, 'important');
  }
  for (const [prop, value] of Object.entries(CARD_HOST_ARMOR)) {
    anchor.style.setProperty(prop, value, 'important');
  }
  if (anchor.ownerDocument !== document) {
    syncHostThemeVars(anchor);
  }

  const existing = anchor.shadowRoot;
  if (existing) return existing;

  const shadow = anchor.attachShadow({ mode: 'open' });
  const doc = anchor.ownerDocument || document;
  const sheet = cardStyleSheet(doc);
  if (sheet) {
    try {
      // 同 Document 下全部卡片共享同一个 CSSStyleSheet 对象
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      injectFallbackStyle(shadow, doc);
    }
  } else {
    injectFallbackStyle(shadow, doc);
  }

  return shadow;
}

/** 楼层 .mes_text 元素；楼层不在 DOM（未渲染/群聊懒渲染）时返回 null。 */
function findMesText(messageId: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.mes[mesid="${messageId}"] .mes_text`);
}

const anchorResizeObservers = new WeakMap<Element, ResizeObserver>();
const pendingHeightFrames = new Set<HTMLIFrameElement>();

function syncIframeHeight(frame: HTMLIFrameElement): void {
  if (!frame.isConnected || pendingHeightFrames.has(frame)) return;
  pendingHeightFrames.add(frame);
  requestAnimationFrame(() => {
    pendingHeightFrames.delete(frame);
    if (!frame.isConnected) return;
    try {
      frame.contentWindow?.dispatchEvent(new Event('resize'));
    } catch {
      // ignore
    }
    requestAnimationFrame(() => {
      if (!frame.isConnected) return;
      try {
        const fdoc = frame.contentDocument;
        if (!fdoc) return;
        const body = fdoc.body;
        const docEl = fdoc.documentElement;
        if (!body && !docEl) return;
        const overflowY = body ? fdoc.defaultView?.getComputedStyle(body).overflowY : '';
        if (overflowY === 'auto' || overflowY === 'scroll') return;
        const neededHeight = Math.max(docEl?.scrollHeight ?? 0, body?.scrollHeight ?? 0);
        if (neededHeight > frame.clientHeight + 2) {
          frame.style.height = `${neededHeight}px`;
        }
      } catch {
        // 跨域或已卸载 iframe 忽略
      }
    });
  });
}

/**
 * 若节点位于同源 `<iframe>` 内，通知所属 iframe 重新同步高度（卡片挂载 / 图片加载完成后调用）。
 */
export function syncIframeHeightForNode(node: Node | null): void {
  if (!node) return;
  const doc = node.ownerDocument;
  if (!doc || doc === document) return;
  const frame = doc.defaultView?.frameElement as HTMLIFrameElement | null | undefined;
  if (frame && frame.tagName === 'IFRAME') syncIframeHeight(frame);
}

function observeAnchorResizeInIframe(anchor: HTMLElement): void {
  if (anchor.ownerDocument === document || typeof ResizeObserver !== 'function') return;
  if (anchorResizeObservers.has(anchor)) return;
  const ro = new ResizeObserver(() => syncIframeHeightForNode(anchor));
  ro.observe(anchor);
  anchorResizeObservers.set(anchor, ro);
}

function unmountKey(key: string): void {
  const record = slotRegistry.get(key);
  if (!record) return;
  const host = record.container.host;
  const ro = anchorResizeObservers.get(host);
  if (ro) {
    ro.disconnect();
    anchorResizeObservers.delete(host);
  }
  // 显式卸载：锚点容器可能已脱离 DOM（.mes_text 被 ST 整体重写），
  // render(null, container) 对已脱离元素依然安全。
  render(null, record.container);
  slotRegistry.delete(key);
}

/** 卸载并清空全部记录（切聊天 / 删除楼层后全量重建）。 */
function unmountAll(): void {
  for (const key of slotRegistry.keys()) {
    unmountKey(key);
  }
}

const observedIframes = new WeakSet<HTMLIFrameElement>();
const frameObservers = new WeakMap<HTMLIFrameElement, MutationObserver>();
const hydratingFloors = new Set<number>();

function isPluginSlotNode(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const el = node as Element;
  return Boolean(
    el.hasAttribute?.('data-bbm-slot') || el.classList?.contains?.('bbm-fallback-slots'),
  );
}

function isOwnIframeMutation(mutations: MutationRecord[]): boolean {
  return mutations.every(m => {
    if (m.addedNodes.length === 0 && m.removedNodes.length === 0) return true;
    for (const n of m.addedNodes) {
      if (!isPluginSlotNode(n)) return false;
    }
    for (const n of m.removedNodes) {
      if (!isPluginSlotNode(n)) return false;
    }
    return true;
  });
}

function isFloorFullyMountedInPlace(messageId: number, ctx: STContext): boolean {
  const msg = ctx.chat[messageId];
  if (!msg) return true;
  const tags = parseImageTags(msg.mes);
  const chatId = ctx.getCurrentChatId();
  const swipeId = msg.swipe_id ?? 0;
  const existingKeys = slotRegistry.keysByMessage(chatId, messageId);
  if (tags.length === 0) return existingKeys.length === 0;
  if (existingKeys.length !== tags.length) return false;

  for (let seq = 0; seq < tags.length; seq += 1) {
    const record = slotRegistry.get(slotRegistry.key(chatId, messageId, swipeId, seq));
    if (!record) return false;
    const host = record.container.host;
    if (host.closest?.('.bbm-fallback-slots')) return false;
    if (checkSlotHealth(host) !== 'ok') return false;
  }
  return true;
}

/**
 * 监听楼层内及 `.mes_block` 关联的所有可见同源 `<iframe>`（前端卡 / 美化脚本重渲染时自动触发本楼重新穿透水合）。
 */
export function observeFloorIframes(mesText: HTMLElement, messageId: number): void {
  for (const frame of collectFloorIframes(mesText)) {
    if (observedIframes.has(frame)) continue;
    observedIframes.add(frame);

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRehydrate = () => {
      if (hydratingFloors.has(messageId)) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (!frame.isConnected || hydratingFloors.has(messageId)) return;
        const ctx = getContext();
        if (!ctx) return;
        if (isFloorFullyMountedInPlace(messageId, ctx)) {
          const mt = findMesText(messageId);
          if (mt && settings.ui.enableBeautifyPenetration) observeFloorIframes(mt, messageId);
          return;
        }
        hydrateMessage(messageId, ctx);
      }, 60);
    };

    const attachInnerObserver = () => {
      try {
        frameObservers.get(frame)?.disconnect();
        const target = frame.contentDocument?.documentElement ?? frame.contentDocument?.body;
        if (!target || typeof MutationObserver !== 'function') return;
        const obs = new MutationObserver(mutations => {
          if (hydratingFloors.has(messageId)) return;
          if (isOwnIframeMutation(mutations)) return;
          scheduleRehydrate();
        });
        obs.observe(target, { childList: true, subtree: true });
        frameObservers.set(frame, obs);
      } catch {
        // 跨域 iframe 忽略
      }
    };

    frame.addEventListener('load', () => {
      attachInnerObserver();
      scheduleRehydrate();
    });
    attachInnerObserver();
  }
}

export function hydrateMessage(messageId: number, ctx: STContext): void {
  hydratingFloors.add(messageId);
  try {
    const chatId = ctx.getCurrentChatId();
    const message = ctx.chat[messageId];

    /** 本次水合后「应该存在」的槽位:key → {锚点, vnode}。消息没了就留空,下面统一卸载。 */
    const desired = new Map<string, { anchor: HTMLElement; vnode: VNode }>();

    if (message) {
      const tags = parseImageTags(message.mes);
      const swipeId = message.swipe_id ?? 0;
      // 槽位可能整个消失(用户删掉 tag / swipe 到 tag 更少的一版):那些槽位再没有卡片
      // 来对账,运行态记录会永久留存,日后同 key 复现时被新卡片误认领。按 tag 数剪掉越界的。
      pruneGenSlots(chatId ?? '-', messageId, swipeId, tags.length);

      if (tags.length > 0) {
        const mesText = findMesText(messageId);
        // 楼层不在 DOM(未渲染/群聊懒渲染):desired 留空,本楼旧记录被卸载,等下次渲染事件
        if (mesText) {
          if (settings.ui.enableBeautifyPenetration) {
            observeFloorIframes(mesText, messageId);
          }
          const anchors = resolveFloorAnchors(
            mesText,
            messageId,
            message.mes,
            settings.ui.enableBeautifyPenetration,
          );
          if (anchors.length !== tags.length) {
            console.warn(
              `[柏宝·改] 楼层 #${messageId} 锚点 ${anchors.length} 个 ≠ 生图 tag ${tags.length} 个,按少者配对`,
            );
          }
          const count = Math.min(anchors.length, tags.length);

          for (let seq = 0; seq < count; seq++) {
            const key = slotRegistry.key(chatId, messageId, swipeId, seq);
            // 从 extra 恢复:当前 tag 原文重算 hash 匹配同槽位历史 → ready(可翻页);
            // 无匹配但有旧提示词结果 → stale(DESIGN-FLOOR-UI.md §7.1)。
            const store = readStore(message);
            const hash = promptHash(tags[seq]);
            const history = historyEntries(store, swipeId, hash, seq);
            const entry = history.length ? history[history.length - 1] : null;
            const staleEntry = entry ? null : latestStaleEntry(store, swipeId, hash, seq);
            const content = parseImageTagContent(tags[seq]);
            desired.set(key, {
              anchor: anchors[seq],
              vnode: h(Card, {
                prompt: content.tag,
                nl: content.nl,
                negative: content.negative,
                characters: content.characters,
                size: content.size,
                kind: imageTagKind(content),
                layout: content.layout ?? null,
                tag: tags[seq],
                messageId,
                seq,
                swipeId,
                history,
                staleEntry,
                // key 的一部分:与 registry.key 的占位口径一致(chatId 缺失时用 '-')
                chatId: chatId ?? '-',
              }),
            });
          }
        }
      }
    }

    // 卸载本楼不在期望集合内的旧记录(跨 swipeId)
    for (const key of slotRegistry.keysByMessage(chatId, messageId)) {
      if (!desired.has(key)) unmountKey(key);
    }

    // 挂载或差分更新
    for (const [key, { anchor, vnode }] of desired) {
      const existing = slotRegistry.get(key);
      if (existing && existing.container.host === anchor) {
        // 同锚点:render 同类型组件 → props patch,不重挂 DOM、不重跑 onMounted。
        ensureShadow(anchor);
        anchor.setAttribute('data-theme', settings.ui.cardTheme || 'st');
        observeAnchorResizeInIframe(anchor);
        existing.vnode = vnode;
        render(vnode, existing.container);
      } else {
        // 卡片渲进锚点的 shadow root,与 ST 样式双向隔离;主题跟随设置(默认 st = 融入宿主配色)
        if (existing) unmountKey(key);
        const shadow = ensureShadow(anchor);
        anchor.setAttribute('data-theme', settings.ui.cardTheme || 'st');
        render(vnode, shadow);
        slotRegistry.set(key, { container: shadow, vnode });
        observeAnchorResizeInIframe(anchor);
        syncIframeHeightForNode(anchor);
      }
    }
  } finally {
    hydratingFloors.delete(messageId);
  }
}

/** Hydrate currently displayed messages without tearing down cards that still have the same anchors. */
function hydrateVisible(ctx: STContext): void {
  for (let messageId = 0; messageId < ctx.chat.length; messageId++) {
    hydrateMessage(messageId, ctx);
  }
}

/** Full rebuild for chat changes or message deletion. */
export function hydrateAll(ctx: STContext): void {
  unmountAll();
  hydrateVisible(ctx);
}

const LATE_HYDRATION_DELAY = 100;
const EXTRA_LATE_HYDRATION_DELAY = 450;

/**
 * 自愈:
 * 1. Pass 1: 体检已挂载槽位,把 detached / hidden-by-beautify 重挂; hidden-by-host 只留痕;
 * 2. Pass 2: 根据 `#chat` 变更上报的 dirtyFloors 增量纳管新 iframe, 并把 0 槽位或停留在兜底区的楼层升级回正文原位。
 */
export function healSlots(dirtyFloors?: ReadonlySet<number>): void {
  let floorsToRehydrate: Set<number> | null = null;
  const hiddenByHostFloors = new Set<number>();

  for (const record of slotRegistry.all()) {
    const host = record.container.host;
    const health = checkSlotHealth(host);
    if (health === 'ok') continue;

    if (health === 'hidden-by-host') {
      warnHiddenByHost(host);
      const hiddenFloor = floorIdOf(host);
      if (hiddenFloor !== null) hiddenByHostFloors.add(hiddenFloor);
      continue;
    }

    const floor = floorIdOf(host);
    // 找不到楼层号:该楼整个不在文档里(切聊天/懒渲染卸载),等渲染事件即可。
    // 记录留着不动——hydrateMessage 会在楼层回来时按 desired 集合正常对账。
    if (floor === null) continue;
    (floorsToRehydrate ??= new Set()).add(floor);
  }

  const ctx = getContext();
  if (!ctx) return;

  if (dirtyFloors && dirtyFloors.size > 0) {
    for (const floor of dirtyFloors) {
      if (floorsToRehydrate?.has(floor) || hiddenByHostFloors.has(floor)) continue;
      const msg = ctx.chat[floor];
      if (!msg || !hasImageTagTrace(msg.mes)) continue;
      const mesText = findMesText(floor);
      if (!mesText) continue;
      if (settings.ui.enableBeautifyPenetration) {
        observeFloorIframes(mesText, floor);
      }
      if (!isFloorFullyMountedInPlace(floor, ctx)) {
        (floorsToRehydrate ??= new Set()).add(floor);
      }
    }
  }

  if (!floorsToRehydrate) return;
  for (const floor of floorsToRehydrate) hydrateMessage(floor, ctx);
}

/** 已提示过的楼层(同一楼别每帧刷一行日志)。 */
const hiddenWarned = new Set<number>();

/**
 * 「卡片被宿主整段隐藏」只留痕,不强改。
 */
function warnHiddenByHost(host: Element): void {
  const floor = floorIdOf(host);
  const id = floor ?? -1;
  if (hiddenWarned.has(id)) return;
  hiddenWarned.add(id);
  console.warn(
    `[柏宝·改] 楼层 #${floor ?? '?'} 的卡片已挂载但不可见:该楼 .mes_text 被 ST 的 ` +
      'inline_media 规则整段隐藏(本楼有附件图且 extra.inline_image 为 false)。' +
      '这是宿主的有意行为,插件不强行解除;如需看到卡片,请让该楼恢复显示正文。',
  );
}

/** 绑定自愈(幂等)。返回 false = `#chat` 不在文档里,宿主环境异常。 */
export function bindSlotSelfHealing(): boolean {
  if (healingBound) return true;
  const chat = document.getElementById('chat');
  if (!chat) return false;
  healingBound = true;
  onChatMutation(healSlots);
  return true;
}

/**
 * Other ST listeners may still replace .mes_text after an event. Hydrate at the end of the
 * event loop, then check again; an unchanged anchor only receives a cheap Vue props patch.
 */
function scheduleHydration(
  task: (ctx: STContext) => void,
  lateTask: (ctx: STContext) => void = task,
  extraLate = false,
): void {
  const chatId = getContext()?.getCurrentChatId();
  const run = () => {
    const current = getContext();
    if (!current || current.getCurrentChatId() !== chatId) return;
    task(current);
  };
  setTimeout(run, 0);
  setTimeout(() => {
    const current = getContext();
    if (!current || current.getCurrentChatId() !== chatId) return;
    lateTask(current);
  }, LATE_HYDRATION_DELAY);
  if (extraLate) {
    setTimeout(() => {
      const current = getContext();
      if (!current || current.getCurrentChatId() !== chatId) return;
      lateTask(current);
    }, EXTRA_LATE_HYDRATION_DELAY);
  }
}

/**
 * Bind message rendering plus the two recovery events used by ST for generation finalization
 * and loading older history.
 */
export function bindFloorHydration(): boolean {
  if (bound) return true;
  const ctx = getContext();
  if (!ctx?.eventSource) return false;

  bound = true;
  const { eventSource, eventTypes } = ctx;
  const onMessage = (messageId: unknown) => {
    const id = Number(messageId);
    if (!Number.isInteger(id)) return;
    scheduleHydration(current => hydrateMessage(id, current), undefined, true);
  };
  const onVisibleReload = () => scheduleHydration(hydrateVisible);
  const onGenerationEnded = (messageCount: unknown) => {
    const id = Number(messageCount) - 1;
    if (Number.isInteger(id) && id >= 0) {
      scheduleHydration(current => hydrateMessage(id, current), undefined, true);
    } else {
      onVisibleReload();
    }
  };
  const onFullReload = () => {
    clearAutoGenerateFlags();
    // A deleted/switched chat no longer owns in-flight generation work.
    clearAllGen();
    // 提示词规划同理:旧聊天的在途规划由 runner 的 cancelAll 中止,这里只清展示态
    clearAllTagPlans();
    // 楼层号在新聊天里指向别的楼,已提示过的记录一并作废,否则新聊天里同号楼永久静默
    hiddenWarned.clear();
    scheduleHydration(hydrateAll, hydrateVisible);
  };

  eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessage);
  eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessage);
  eventSource.on(eventTypes.MESSAGE_UPDATED, onMessage);
  eventSource.on(eventTypes.MESSAGE_SWIPED, onMessage);
  eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
  if (eventTypes.MORE_MESSAGES_LOADED) {
    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, onVisibleReload);
  }
  eventSource.on(eventTypes.MESSAGE_DELETED, onFullReload);
  eventSource.on(eventTypes.CHAT_CHANGED, onFullReload);

  scheduleHydration(hydrateAll, hydrateVisible);

  // 自愈层:兜住 ST 与第三方那些「重写 .mes_text 但不发事件」的路径(见文件头注释)
  bindSlotSelfHealing();

  // 卡片主题改了 → 就地改各卡片 host 的 data-theme(不必重水合,令牌是 CSS 变量,自动生效)
  watch(
    () => settings.ui.cardTheme,
    theme => {
      for (const record of slotRegistry.all()) {
        const host = record.container.host;
        if (host instanceof HTMLElement) host.setAttribute('data-theme', theme || 'st');
      }
    },
  );
  // NAI 并发上限 → 各接入点的闸门(ComfyUI 不限并发,靠服务端队列)。
  // 删掉的接入点不必回收闸门:没人再往那个 id 上取槽,留着的只是一个空对象。
  watch(
    () => settings.nai.endpoints.map(ep => [ep.id, ep.concurrency] as const),
    pairs => {
      for (const [id, concurrency] of pairs) setNaiConcurrency(concurrency, id);
    },
    { immediate: true },
  );
  return true;
}
