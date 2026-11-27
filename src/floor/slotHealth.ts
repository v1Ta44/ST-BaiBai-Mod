/**
 * 卡片「还活着吗」的判据(纯函数,便于单测)。
 *
 * 背景:锚点 `<div data-bbm-slot>` 活在楼层的 `.mes_text` **里面**,而 ST 自己有好几条
 * 路径会整体重写 `.mes_text`,其中相当一部分**不发任何事件**:
 * - `updateMessageBlock`(script.js) `.mes_text.html(...)`,无事件;
 * - `messageEditCancel` / `messageEditDone` 的 `.mes_text.empty()`;
 * - 右滑生成时 `.mes_text.html('...')`;
 * - 第三方插件(提示词模板类)在自己的渲染钩子里 `container.html(newContent)`。
 * 纯事件驱动的水合对这些一律无感:锚点连同 shadow root 一起被删,卡片就此消失,
 * 而 genState 是模块级的,在途生成照样跑完——用户看到的正是「图在生成,楼层里没界面」。
 *
 * 另一类是**没被删、但看不见**:
 * 1. `.mes_text.inline_media { display:none }`(style.css):只要本楼 `extra.media` 非空且
 *    `extra.inline_image === false`,ST 就挂上 `inline_media` 把整段正文隐藏(`hidden-by-host`)。
 * 2. 正文美化或前端卡脚本把原标签所在的 `<pre>`/`<code>`/`display:none` 容器隐藏,
 *    然后另外在可见区域/Shadow DOM/同源 iframe 里渲染美化正文(`hidden-by-beautify`)。
 *
 * 故判据分三种异常:
 * - `detached`:锚点(或其所在的 ShadowRoot 宿主 / iframe 元素)脱离文档 → 重新水合本楼;
 * - `hidden-by-host`:祖先 `.mes_text` 带 `inline_media` → 只留痕,不强改;
 * - `hidden-by-beautify`:被美化容器/代码块/关闭的 `<details>` 隐藏 → 重新水合穿透到可见容器。
 */

/** 单个已挂载槽位的体检结论。 */
export type SlotHealth = 'ok' | 'detached' | 'hidden-by-host' | 'hidden-by-beautify';

/**
 * 宿主把 `.mes_text` 整段隐藏时挂的 class(style.css 里 `display:none`)。
 */
export const HOST_HIDE_CLASS = 'inline_media';

const HIDDEN_ANCESTOR_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'TEXTAREA',
  'PRE',
  'CODE',
  'SVG',
  'HEAD',
]);

const INLINE_HIDE_STYLE_RE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\b/i;

/**
 * 沿 DOM 树向上走一步，遇到开放 ShadowRoot 时跳到其 host，遇到同源 iframe 文档边界时跳到 frameElement。
 * 兼容只实现极小 DOM 表面的测试假节点。
 */
export function parentCrossingBoundaries(el: Element): Element | null {
  const parent = (el as { parentElement?: Element | null }).parentElement;
  if (parent) return parent;

  const root =
    typeof (el as { getRootNode?: unknown }).getRootNode === 'function'
      ? (el as { getRootNode: () => unknown }).getRootNode()
      : null;
  if (root && typeof root === 'object' && 'host' in root) {
    const shadowHost = (root as { host?: unknown }).host;
    if (shadowHost && typeof shadowHost === 'object' && shadowHost !== el) {
      return shadowHost as Element;
    }
  }

  const ownerDoc = (el as { ownerDocument?: Document | null }).ownerDocument;
  const frameEl = ownerDoc?.defaultView?.frameElement ?? null;
  if (frameEl && frameEl !== el) return frameEl;
  return null;
}

/**
 * 判断单个元素自身是否处于隐藏或非视觉渲染容器状态。
 * 不排斥 `opacity: 0`，避免误杀淡入动画容器。
 */
export function isHiddenElement(el: Element, childInPath?: Element | null): boolean {
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag && HIDDEN_ANCESTOR_TAGS.has(tag)) return true;

  if (typeof el.hasAttribute === 'function') {
    if (el.hasAttribute('hidden')) return true;
    if (tag === 'DETAILS' && !el.hasAttribute('open')) {
      const childTag =
        childInPath && typeof childInPath.tagName === 'string'
          ? childInPath.tagName.toUpperCase()
          : '';
      if (childTag !== 'SUMMARY') return true;
    }
  }

  const styleObj = (el as { style?: { display?: string; visibility?: string } }).style;
  if (styleObj) {
    const d = typeof styleObj.display === 'string' ? styleObj.display.trim().toLowerCase() : '';
    const v =
      typeof styleObj.visibility === 'string' ? styleObj.visibility.trim().toLowerCase() : '';
    if (d === 'none' || v === 'hidden' || v === 'collapse') return true;
  }

  if (typeof el.getAttribute === 'function') {
    const rawStyle = el.getAttribute('style');
    if (rawStyle && INLINE_HIDE_STYLE_RE.test(rawStyle)) return true;
  }

  const getComputedStyleFn = el.ownerDocument?.defaultView?.getComputedStyle;
  if (typeof getComputedStyleFn === 'function') {
    try {
      const cs = getComputedStyleFn(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') {
        return true;
      }
    } catch {
      // 跨环境或未挂载节点忽略计算样式异常
    }
  }

  return false;
}

/**
 * 从 `el` 的父级起（跳过 `el` 自身，避免误杀仅被 `div:empty` 隐藏但即将加护甲的有效槽位）
 * 跨 Shadow DOM / 同源 iframe 边界向上检查是否有隐藏祖先。
 */
export function isHiddenByAncestors(el: Element, stopAt?: Element | null): boolean {
  let prev: Element = el;
  let cur = parentCrossingBoundaries(el);
  let depth = 0;

  while (cur && depth < 128) {
    const tag = typeof cur.tagName === 'string' ? cur.tagName.toUpperCase() : '';
    if (tag === 'BODY' || tag === 'HTML') {
      // 跨出 iframe 文档到父文档的 frameElement，继续沿外层校验
      const ownerDoc = (cur as { ownerDocument?: Document | null }).ownerDocument;
      const frameEl = ownerDoc?.defaultView?.frameElement ?? null;
      if (frameEl && frameEl !== cur) {
        if (stopAt && frameEl === stopAt) return false;
        if (isHiddenElement(frameEl, cur)) return true;
        prev = frameEl;
        cur = parentCrossingBoundaries(frameEl);
        depth += 1;
        continue;
      }
      return false;
    }
    if (stopAt && cur === stopAt) return false;
    if (isHiddenElement(cur, prev)) return true;
    prev = cur;
    cur = parentCrossingBoundaries(cur);
    depth += 1;
  }

  return false;
}

function findEnclosingByClassOrSelector(
  el: Element,
  selector: string,
  matchClass?: string,
): Element | null {
  let cur: Element | null = el;
  let depth = 0;
  while (cur && depth < 128) {
    if (typeof cur.closest === 'function') {
      const hit = cur.closest(selector);
      if (hit) return hit;
    }
    if (matchClass && cur.classList?.contains?.(matchClass)) return cur;

    const next = parentCrossingBoundaries(cur);
    if (!next) break;
    // 若 cur.closest 未跨边界，next 会跨过 ShadowRoot 或 iframe 边界
    if (next === cur.parentElement && typeof cur.closest === 'function') {
      // 已经在 cur.closest(selector) 里查过同文档祖先，直接跳到文档/ShadowRoot 边界外
      const root: unknown =
        typeof (cur as { getRootNode?: unknown }).getRootNode === 'function'
          ? (cur as { getRootNode: () => unknown }).getRootNode()
          : null;
      if (root && typeof root === 'object' && 'host' in root && (root as { host?: unknown }).host) {
        cur = (root as { host: Element }).host;
        depth += 1;
        continue;
      }
      const frameEl: Element | null = cur.ownerDocument?.defaultView?.frameElement ?? null;
      if (frameEl) {
        cur = frameEl;
        depth += 1;
        continue;
      }
      break;
    }
    cur = next;
    depth += 1;
  }
  return null;
}

function areBoundaryHostsConnected(el: Element): boolean {
  let cur: Element | null = el;
  let depth = 0;
  while (cur && depth < 128) {
    if (!cur.isConnected) return false;
    const ownerDoc: Document | null | undefined = (cur as { ownerDocument?: Document | null })
      .ownerDocument;
    const root: unknown =
      typeof (cur as { getRootNode?: unknown }).getRootNode === 'function'
        ? (cur as { getRootNode: () => unknown }).getRootNode()
        : null;
    if (root && typeof root === 'object' && 'host' in root) {
      const shadowHost = (root as { host?: unknown }).host;
      if (shadowHost && typeof shadowHost === 'object' && shadowHost !== cur) {
        cur = shadowHost as Element;
        depth += 1;
        continue;
      }
    }
    const frameEl: Element | null = ownerDoc?.defaultView?.frameElement ?? null;
    if (frameEl && frameEl !== cur) {
      cur = frameEl;
      depth += 1;
      continue;
    }
    break;
  }
  return true;
}

/**
 * 体检一个锚点。`host` 传锚点元素本身(即 shadow root 的宿主)。
 *
 * 注意顺序:先判 detached。脱离文档的元素 `closest()` 仍能沿着已断开的子树往上走、
 * 也可能真找到带 class 的 `.mes_text`(整段被 ST 换下来的那份),若先判 hidden
 * 就会把「已经被删掉的楼」误报成「被隐藏」,于是既不重挂、又去改一个不在文档里的
 * 节点的 class,卡片永远回不来。
 */
export function checkSlotHealth(host: Element | null | undefined): SlotHealth {
  if (!host || !host.isConnected) return 'detached';
  if (!areBoundaryHostsConnected(host)) return 'detached';

  const mesText = findEnclosingByClassOrSelector(host, '.mes_text', 'mes_text');
  if (mesText?.classList?.contains?.(HOST_HIDE_CLASS)) return 'hidden-by-host';

  if (isHiddenByAncestors(host)) return 'hidden-by-beautify';
  return 'ok';
}

/**
 * 从锚点找出它所属的楼层号(`.mes[mesid]` 或 `data-bbm-floor`，兼容任意层嵌套同源 iframe 与 Shadow DOM)。
 * 找不到返回 null。
 */
export function floorIdOf(host: Element | null | undefined): number | null {
  if (!host) return null;
  const dataFloor = typeof host.getAttribute === 'function' ? host.getAttribute('data-bbm-floor') : null;
  if (dataFloor !== null && dataFloor.trim() !== '') {
    const parsed = Number(dataFloor);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  const mes = findEnclosingByClassOrSelector(host, '.mes', 'mes');
  const raw = mes?.getAttribute('mesid');
  // 空串/纯空白必须先挡掉:Number('') 与 Number(' ') 都是 0,会把「mesid 缺失的
  // .mes 外壳」当成第 0 楼,于是自愈去重水合一个毫不相干的楼层。
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
}
