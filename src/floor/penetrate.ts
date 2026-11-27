import {
  HOST_HIDE_CLASS,
  isHiddenByAncestors,
  isHiddenElement,
} from '@/floor/slotHealth';
import {
  BBI_SLOT_SELECTOR,
  IMAGE_TAG_FIND_REGEX,
  IMAGE_TAG_SLOT_SENTINEL,
  parseImageTags,
} from '@/st/imageTagRegex';

export type PenetrationRoot = Element | ShadowRoot;

export interface TagAnchorMeta {
  seq: number;
  rawTag: string;
  anchorBefore: string;
  anchorAfter: string;
  anchorsBefore: string[];
  anchorsAfter: string[];
}

export interface TextRun {
  node: Text;
  start: number;
  end: number;
}

export interface LogicalTextResult {
  text: string;
  runs: TextRun[];
}

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEXTAREA',
  'SVG',
  'TEMPLATE',
  'PRE',
  'CODE',
  'IFRAME',
  'OBJECT',
  'CANVAS',
  'AUDIO',
  'VIDEO',
  'SELECT',
  'OPTION',
  'HEAD',
  'TITLE',
  'META',
  'LINK',
]);

const INLINE_TAGS = new Set([
  'SPAN',
  'EM',
  'I',
  'B',
  'STRONG',
  'U',
  'S',
  'SMALL',
  'MARK',
  'SUB',
  'SUP',
  'Q',
  'A',
  'FONT',
  'RUBY',
  'RT',
  'RP',
  'CITE',
  'ABBR',
  'TIME',
]);

const BLOCK_LIFT_TAGS = new Set([
  'P',
  'BLOCKQUOTE',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'FIGCAPTION',
]);

const LEAF_CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE']);
const NESTED_BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'BLOCKQUOTE',
  'UL',
  'OL',
  'SECTION',
  'ARTICLE',
  'TABLE',
]);

const ST_CHROME_CLASSES = new Set([
  'ch_name',
  'mes_buttons',
  'extraMesButtons',
  'mes_edit',
  'mes_reasoning_details',
  'mes_media',
  'swipe_left',
  'swipe_right',
  'swipes-counter',
  'bbm-fallback-slots',
]);

const ST_CHROME_SELECTOR =
  '.ch_name, .mes_buttons, .extraMesButtons, .mes_edit, .mes_reasoning_details, .mes_media, .swipe_left, .swipe_right, .swipes-counter, .bbm-fallback-slots';

const NON_ALNUM_UNICODE_RE = /[^\p{L}\p{N}]/u;

function stripMarkupToProse(raw: string): string {
  return raw
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/##bbm_image[\s\S]*?bbm_image##/gi, '')
    .replace(/<bbm_image\b[^>]*>[\s\S]*?<\/bbm_image>/gi, '')
    .replace(/<bbi_image\b[^>]*>[\s\S]*?<\/bbi_image>/gi, '')
    .split(IMAGE_TAG_SLOT_SENTINEL)
    .join('')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/^[ \t]*(?:>+|[#]{1,6})\s*/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r\n|\r/g, '\n')
    .trim();
}

function buildNormalizedMap(src: string): { norm: string; rawIndices: number[] } {
  let norm = '';
  const rawIndices: number[] = [];
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (NON_ALNUM_UNICODE_RE.test(ch)) continue;
    norm += ch.toLowerCase();
    rawIndices.push(i);
  }
  return { norm, rawIndices };
}

function normLen(src: string): number {
  let count = 0;
  for (let i = 0; i < src.length; i += 1) {
    if (!NON_ALNUM_UNICODE_RE.test(src[i])) count += 1;
  }
  return count;
}

/**
 * 从 `message.mes` 原文提取每个 `<bbm_image>` 槽位前后的纯文本锚点线索（含多行回退候选）。
 */
export function extractTagAnchors(mes: string): TagAnchorMeta[] {
  const source = String(mes ?? '');
  const re = new RegExp(IMAGE_TAG_FIND_REGEX.source, 'gi');
  const out: TagAnchorMeta[] = [];
  let seq = 0;

  for (let match = re.exec(source); match; match = re.exec(source)) {
    const rawBefore = source.slice(Math.max(0, match.index - 800), match.index);
    const rawAfter = source.slice(
      match.index + match[0].length,
      Math.min(source.length, match.index + match[0].length + 400),
    );

    const cleanBefore = stripMarkupToProse(rawBefore);
    const rawLinesBefore = cleanBefore
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    const strongBefore = rawLinesBefore.filter(s => normLen(s) >= 4);
    const pickedBefore = strongBefore.length
      ? strongBefore
      : rawLinesBefore.filter(s => s.length >= 2);
    const anchorsBefore = pickedBefore
      .slice(-3)
      .reverse()
      .map(line => line.slice(-100).trim())
      .filter(Boolean);
    if (!anchorsBefore.length && cleanBefore) {
      anchorsBefore.push(cleanBefore.slice(-100).trim());
    }

    const cleanAfter = stripMarkupToProse(rawAfter);
    const rawLinesAfter = cleanAfter
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    const strongAfter = rawLinesAfter.filter(s => normLen(s) >= 4);
    const pickedAfter = strongAfter.length
      ? strongAfter
      : rawLinesAfter.filter(s => s.length >= 2);
    const anchorsAfter = pickedAfter
      .slice(0, 2)
      .map(line => line.slice(0, 100).trim())
      .filter(Boolean);
    if (!anchorsAfter.length && cleanAfter) {
      anchorsAfter.push(cleanAfter.slice(0, 100).trim());
    }

    out.push({
      seq,
      rawTag: match[0],
      anchorBefore: anchorsBefore[0] ?? '',
      anchorAfter: anchorsAfter[0] ?? '',
      anchorsBefore,
      anchorsAfter,
    });
    seq += 1;
  }

  return out;
}

const NF_SHOW_TEXT = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4;
const NF_FILTER_ACCEPT = typeof NodeFilter !== 'undefined' ? NodeFilter.FILTER_ACCEPT : 1;
const NF_FILTER_REJECT = typeof NodeFilter !== 'undefined' ? NodeFilter.FILTER_REJECT : 2;
const NF_FILTER_SKIP = typeof NodeFilter !== 'undefined' ? NodeFilter.FILTER_SKIP : 3;

function rootBoundaryElement(root: PenetrationRoot): Element | null {
  if ('tagName' in root) return root;
  return (root as { host?: Element }).host ?? null;
}

function isChromeOrSlotElement(el: Element): boolean {
  if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-bbm-slot')) return true;
  if (el.classList) {
    for (const cls of ST_CHROME_CLASSES) {
      if (el.classList.contains(cls)) return true;
    }
  }
  if (typeof el.closest === 'function') {
    if (el.closest('[data-bbm-slot], .bbm-fallback-slots, .mes_reasoning_details')) return true;
    if (el.closest(ST_CHROME_SELECTOR)) return true;
  }
  return false;
}

/**
 * 用 TreeWalker 采集容器内可见文本流及其对应的 DOM Text 节点偏移映射，
 * 跳过 `<script>` / `<style>` / `<pre>` / `<code>` / 隐藏祖先 / 既有卡片锚点与兜底容器。
 */
export function collectLogicalText(root: PenetrationRoot): LogicalTextResult {
  const doc = (root as Node).ownerDocument || document;
  const stopAt = rootBoundaryElement(root);
  const walker = doc.createTreeWalker(root as unknown as Node, NF_SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NF_FILTER_REJECT;
      const tag = parent.tagName?.toUpperCase?.() ?? '';
      if (SKIP_TAGS.has(tag)) return NF_FILTER_REJECT;
      if (parent.closest?.('[data-bbm-slot], .bbm-fallback-slots, .mes_reasoning_details')) {
        return NF_FILTER_REJECT;
      }
      if (isHiddenElement(parent) || isHiddenByAncestors(parent, stopAt)) {
        return NF_FILTER_REJECT;
      }
      return node.nodeValue ? NF_FILTER_ACCEPT : NF_FILTER_SKIP;
    },
  });

  let text = '';
  const runs: TextRun[] = [];
  let cur = walker.nextNode();
  while (cur) {
    const t = cur as Text;
    const val = t.nodeValue ?? '';
    const start = text.length;
    text += val;
    runs.push({ node: t, start, end: text.length });
    cur = walker.nextNode();
  }

  return { text, runs };
}

function diceBigrams(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const mapA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const g = a.slice(i, i + 2);
    mapA.set(g, (mapA.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const g = b.slice(i, i + 2);
    const cnt = mapA.get(g) ?? 0;
    if (cnt > 0) {
      hits += 1;
      mapA.set(g, cnt - 1);
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

/**
 * 在被美化标签/额外空白/符号装饰打散的纯文本中模糊定位原文句段：
 * 1. 原文精确子串匹配；
 * 2. 原文尾段（或 `preferHead` 首段）精确匹配；
 * 3. Unicode 字母数字归一化精确匹配；
 * 4. 归一化 14/10 字尾段（或首段）匹配；
 * 5. 限宽（<=32 字符）Bigram Dice 滑窗相似度匹配（阈值 >= 0.72）。
 */
export function fuzzyMatchLine(
  haystack: string,
  needle: string,
  minStartOffset = 0,
  preferHead = false,
): { start: number; end: number } | null {
  const cleanNeedle = needle.trim();
  const startPos = Math.max(0, minStartOffset);
  if (!haystack || cleanNeedle.length < 2) return null;

  const exactIdx = haystack.indexOf(cleanNeedle, startPos);
  if (exactIdx >= 0) {
    return { start: exactIdx, end: exactIdx + cleanNeedle.length };
  }

  const exactSlice = preferHead ? cleanNeedle.slice(0, 24) : cleanNeedle.slice(-24);
  if (exactSlice.length >= 6) {
    const sliceIdx = haystack.indexOf(exactSlice, startPos);
    if (sliceIdx >= 0) {
      return { start: sliceIdx, end: sliceIdx + exactSlice.length };
    }
  }

  const normNeedle = buildNormalizedMap(cleanNeedle).norm;
  if (normNeedle.length < 3) return null;

  const subHay = haystack.slice(startPos);
  const hayMap = buildNormalizedMap(subHay);
  if (!hayMap.norm) return null;

  const normIdx = hayMap.norm.indexOf(normNeedle);
  if (normIdx >= 0) {
    const start = startPos + hayMap.rawIndices[normIdx];
    const endRaw = hayMap.rawIndices[normIdx + normNeedle.length - 1] + 1;
    return { start, end: startPos + endRaw };
  }

  for (const sliceLen of [14, 10]) {
    if (normNeedle.length > sliceLen) {
      const subNorm = preferHead
        ? normNeedle.slice(0, sliceLen)
        : normNeedle.slice(-sliceLen);
      const tIdx = hayMap.norm.indexOf(subNorm);
      if (tIdx >= 0) {
        const start = startPos + hayMap.rawIndices[tIdx];
        const endRaw = hayMap.rawIndices[tIdx + subNorm.length - 1] + 1;
        return { start, end: startPos + endRaw };
      }
    }
  }

  const boundedNeedle =
    normNeedle.length > 32
      ? preferHead
        ? normNeedle.slice(0, 32)
        : normNeedle.slice(-32)
      : normNeedle;
  const winLen = boundedNeedle.length;
  if (winLen >= 4 && hayMap.norm.length >= winLen) {
    let bestScore = 0;
    let bestNormStart = -1;
    const maxStart = hayMap.norm.length - winLen;
    const step = Math.max(1, Math.floor(winLen / 8));
    for (let i = 0; i <= maxStart; i += step) {
      const slice = hayMap.norm.slice(i, i + winLen);
      const score = diceBigrams(slice, boundedNeedle);
      if (score > bestScore) {
        bestScore = score;
        bestNormStart = i;
      }
    }
    if (maxStart % step !== 0) {
      const slice = hayMap.norm.slice(maxStart, maxStart + winLen);
      const score = diceBigrams(slice, boundedNeedle);
      if (score > bestScore) {
        bestScore = score;
        bestNormStart = maxStart;
      }
    }
    if (bestScore >= 0.72 && bestNormStart >= 0) {
      const start = startPos + hayMap.rawIndices[bestNormStart];
      const endRaw = hayMap.rawIndices[bestNormStart + winLen - 1] + 1;
      return { start, end: startPos + endRaw };
    }
  }

  return null;
}

function collectRootsAndIframes(mesTextEl: HTMLElement): {
  roots: PenetrationRoot[];
  iframes: HTMLIFrameElement[];
} {
  if (mesTextEl.classList?.contains?.(HOST_HIDE_CLASS)) {
    return { roots: [], iframes: [] };
  }

  const roots: PenetrationRoot[] = [];
  const iframes: HTMLIFrameElement[] = [];
  const visitedRoots = new Set<PenetrationRoot>();
  const visitedFrames = new Set<HTMLIFrameElement>();

  const scanElementDescendants = (container: PenetrationRoot, collectTextRoots: boolean) => {
    const children = [...(container.children ?? [])];
    for (const el of children) {
      if (isChromeOrSlotElement(el)) continue;
      const tag = el.tagName?.toUpperCase?.() ?? '';

      if (tag === 'IFRAME') {
        if (!isHiddenElement(el) && !isHiddenByAncestors(el)) {
          const frame = el as HTMLIFrameElement;
          if (!visitedFrames.has(frame)) {
            visitedFrames.add(frame);
            iframes.push(frame);
          }
          try {
            const body = frame.contentDocument?.body;
            if (body) walkRoot(body, body);
          } catch {
            // 跨域 iframe 禁止访问，安全跳过
          }
        }
        continue;
      }

      if (SKIP_TAGS.has(tag)) continue;
      if (isHiddenElement(el)) continue;

      const sr = (el as { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) {
        if (collectTextRoots) {
          walkRoot(sr, null);
        } else {
          scanElementDescendants(sr, false);
        }
      }

      scanElementDescendants(el, collectTextRoots);
    }
  };

  function walkRoot(root: PenetrationRoot, stopAt: Element | null): void {
    if (visitedRoots.has(root)) return;
    if ('tagName' in root) {
      if (isHiddenElement(root) || isHiddenByAncestors(root, stopAt)) return;
    }
    visitedRoots.add(root);
    roots.push(root);
    scanElementDescendants(root, true);
  }

  const mesTextHidden = isHiddenElement(mesTextEl) || isHiddenByAncestors(mesTextEl);
  if (!mesTextHidden) {
    walkRoot(mesTextEl, mesTextEl.parentElement);
  }

  const mesBlock =
    mesTextEl.closest?.('.mes_block')
    ?? (mesTextEl.parentElement?.classList?.contains?.('mes_block') ? mesTextEl.parentElement : null);

  if (mesBlock) {
    for (const sibling of [...(mesBlock.children ?? [])]) {
      if (sibling === mesTextEl) continue;
      if (isChromeOrSlotElement(sibling)) continue;
      const tag = sibling.tagName?.toUpperCase?.() ?? '';
      if (SKIP_TAGS.has(tag) && tag !== 'IFRAME') continue;
      if (isHiddenElement(sibling)) continue;

      if (tag === 'IFRAME') {
        const frame = sibling as HTMLIFrameElement;
        if (!visitedFrames.has(frame)) {
          visitedFrames.add(frame);
          iframes.push(frame);
        }
        try {
          const body = frame.contentDocument?.body;
          if (body) walkRoot(body, body);
        } catch {
          // 跨域 iframe 跳过
        }
        continue;
      }

      if (mesTextHidden) {
        walkRoot(sibling, mesBlock);
      } else {
        scanElementDescendants(sibling, false);
      }
    }
  }

  return { roots, iframes };
}

/**
 * 收集候选 DOM 根容器：主 `.mes_text` + 嵌套同源 `<iframe>` + 开放 `ShadowRoot` +
 * （在 `.mes_text` 被美化隐藏时）`.mes_block` 内同级可见美化容器。
 */
export function collectCandidateRoots(mesTextEl: HTMLElement): PenetrationRoot[] {
  return collectRootsAndIframes(mesTextEl).roots;
}

/**
 * 发现当前楼层关联的所有可见同源 `<iframe>`（含 `.mes_text` 内、嵌套及 `.mes_block` 同级容器）。
 */
export function collectFloorIframes(mesTextEl: HTMLElement): HTMLIFrameElement[] {
  return collectRootsAndIframes(mesTextEl).iframes;
}

function createSlotElement(doc: Document, floorId: number, penetrated: boolean): HTMLElement {
  const div = doc.createElement('div');
  div.setAttribute('data-bbm-slot', '');
  div.setAttribute('data-bbm-floor', String(floorId));
  if (penetrated) div.setAttribute('data-bbm-penetrated', '1');
  return div;
}

function createPenetratedSlot(doc: Document, floorId: number): HTMLElement {
  return createSlotElement(doc, floorId, true);
}

const SINGLE_NODE_TOKEN_RE = /(?:@@BBMSLOT@@|##bbm_image[\s\S]+?bbm_image##)/gi;

function hasVisibleNonSlotContent(node: Node): boolean {
  if (!('tagName' in node)) {
    return Boolean((node as Text).nodeValue?.trim());
  }
  const el = node as Element;
  if (el.hasAttribute?.('data-bbm-slot')) return true;
  if (SKIP_TAGS.has(el.tagName?.toUpperCase?.() ?? '')) return false;
  for (const ch of [...(el.childNodes ?? [])]) {
    if (hasVisibleNonSlotContent(ch)) return true;
  }
  return false;
}

function hasOtherVisibleContent(container: Element, targetChild: Node): boolean {
  for (const ch of [...(container.childNodes ?? [])]) {
    if (ch === targetChild) continue;
    if (!('tagName' in ch)) {
      if ((ch as Text).nodeValue?.trim()) return true;
    } else if (hasVisibleNonSlotContent(ch)) {
      return true;
    }
  }
  return false;
}

function findSentinelShellElement(root: PenetrationRoot, innerNode: Node): Element | null {
  let cur: Node = innerNode;
  let shellEl: Element | null = null;

  while (cur.parentNode && cur.parentNode !== root) {
    const parent = cur.parentNode;
    if (!('tagName' in parent)) break;
    const parentEl = parent as Element;
    const tag = parentEl.tagName?.toUpperCase?.() ?? '';
    if (tag === 'BODY' || tag === 'HTML') break;
    if (!(INLINE_TAGS.has(tag) || BLOCK_LIFT_TAGS.has(tag))) break;
    if (hasOtherVisibleContent(parentEl, cur)) break;

    shellEl = parentEl;
    cur = parentEl;
    if (BLOCK_LIFT_TAGS.has(tag)) break;
  }

  return shellEl;
}

/**
 * 将可见文本节点中的纯文本哨兵 `@@BBMSLOT@@` 及单节点 `##bbm_image ... bbm_image##`
 * 原位物化为 `<div data-bbm-slot>`。
 * 跳过隐藏容器（`display:none` / `[hidden]` / 关闭的 `<details>`）与 `<pre><code>` 等源码块。
 */
function materializeSentinelTokens(
  roots: PenetrationRoot[],
  floorId: number,
  penetrated: boolean,
): void {
  for (const root of roots) {
    const doc = (root as Node).ownerDocument || document;
    const stopAt = rootBoundaryElement(root);
    const walker = doc.createTreeWalker(root as unknown as Node, NF_SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName?.toUpperCase?.() ?? '')) {
          return NF_FILTER_REJECT;
        }
        if (parent.closest?.('[data-bbm-slot], .bbm-fallback-slots, .mes_reasoning_details')) {
          return NF_FILTER_REJECT;
        }
        if (isHiddenElement(parent) || isHiddenByAncestors(parent, stopAt)) {
          return NF_FILTER_REJECT;
        }
        const val = node.nodeValue;
        if (!val) return NF_FILTER_SKIP;
        return val.includes(IMAGE_TAG_SLOT_SENTINEL) || /##bbm_image[\s\S]+?bbm_image##/i.test(val)
          ? NF_FILTER_ACCEPT
          : NF_FILTER_SKIP;
      },
    });

    const targets: Text[] = [];
    let cur = walker.nextNode();
    while (cur) {
      targets.push(cur as Text);
      cur = walker.nextNode();
    }

    for (const textNode of targets) {
      if (!textNode.parentNode) continue;
      const val = textNode.nodeValue ?? '';
      const matches = [...val.matchAll(new RegExp(SINGLE_NODE_TOKEN_RE.source, 'gi'))];
      if (!matches.length) continue;

      const isSingle = matches.length === 1;
      const firstMatch = matches[0];
      const firstIdx = firstMatch.index ?? 0;
      const tokenLen = firstMatch[0].length;
      const before = val.slice(0, firstIdx);
      const after = val.slice(firstIdx + tokenLen);

      // 情形 A: 整段/整内联壳只包着单个哨兵或标签（例如 <p>@@BBMSLOT@@</p>），直接替换外壳避免畸形嵌套
      if (isSingle && !before.trim() && !after.trim()) {
        const shellEl = findSentinelShellElement(root, textNode);
        if (shellEl && shellEl.parentNode) {
          shellEl.parentNode.replaceChild(createSlotElement(doc, floorId, penetrated), shellEl);
          continue;
        }
      }

      // 情形 B: 句首/句尾单个标记，剔除文本标记并将槽位提权到段落块外
      if (isSingle) {
        const atEnd = !after.trim() && !!before.trim();
        const atStart = !before.trim() && !!after.trim();
        if (atEnd || atStart) {
          const liftEl = resolveBlockLiftTarget(
            root,
            textNode,
            atStart ? firstIdx : firstIdx + tokenLen,
            atStart,
          );
          if (liftEl && liftEl.parentNode) {
            textNode.nodeValue = atEnd
              ? before.replace(/[ \t]+$/, '')
              : after.replace(/^[ \t]+/, '');
            const slot = createSlotElement(doc, floorId, penetrated);
            if (atStart) {
              liftEl.parentNode.insertBefore(slot, liftEl);
            } else {
              liftEl.parentNode.insertBefore(slot, findImmediateNextSibling(liftEl));
            }
            continue;
          }
        }
      }

      // 情形 C: 一般情况（多个标记或平铺文本块），原位切分替换文本节点
      const frag = doc.createDocumentFragment();
      let cursor = 0;
      for (const m of matches) {
        const idx = m.index ?? 0;
        if (idx > cursor) {
          frag.appendChild(doc.createTextNode(val.slice(cursor, idx)));
        }
        frag.appendChild(createSlotElement(doc, floorId, penetrated));
        cursor = idx + m[0].length;
      }
      if (cursor < val.length) {
        frag.appendChild(doc.createTextNode(val.slice(cursor)));
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }
}

function findRunAtOffset(runs: TextRun[], charOffset: number, inclusiveEnd: boolean): {
  run: TextRun;
  localOffset: number;
} | null {
  for (const run of runs) {
    const match = inclusiveEnd ? charOffset <= run.end : charOffset < run.end;
    if (match) {
      const len = run.node.nodeValue?.length ?? 0;
      return {
        run,
        localOffset: Math.max(0, Math.min(len, charOffset - run.start)),
      };
    }
  }
  const last = runs[runs.length - 1];
  if (!last) return null;
  const len = last.node.nodeValue?.length ?? 0;
  return { run: last, localOffset: Math.max(0, Math.min(len, charOffset - last.start)) };
}

/**
 * 当 Markdown/引号美化将 `##bbm_image ... bbm_image##` 撕裂到多个内联节点（如 `<em>`/`<span>`）时，
 * 通过可见文本流定位并用 `Range.deleteContents()` 跨节点完整清除并原位物化卡片槽位。
 */
function materializeCrossNodeHashTags(
  roots: PenetrationRoot[],
  floorId: number,
  penetrated: boolean,
): void {
  for (const root of roots) {
    const { text, runs } = collectLogicalText(root);
    if (!text || !runs.length) continue;
    if (!/##bbm_image/i.test(text) || !/bbm_image##/i.test(text)) continue;

    const matches: Array<{ start: number; end: number }> = [];
    const re = /##bbm_image[\s\S]+?bbm_image##/gi;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index !== undefined) {
        matches.push({ start: m.index, end: m.index + m[0].length });
      }
    }
    if (!matches.length) continue;

    const doc = (root as Node).ownerDocument || document;
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const { start, end } = matches[i];
      const startPos = findRunAtOffset(runs, start, false);
      const endPos = findRunAtOffset(runs, end, true);
      if (!startPos || !endPos) continue;

      const slot = createSlotElement(doc, floorId, penetrated);
      try {
        const range = doc.createRange();
        range.setStart(startPos.run.node, startPos.localOffset);
        range.setEnd(endPos.run.node, endPos.localOffset);
        range.deleteContents();
        range.insertNode(slot);
      } catch {
        continue;
      }

      const shellEl = findSentinelShellElement(root, slot);
      if (shellEl && shellEl.parentNode) {
        shellEl.parentNode.replaceChild(slot, shellEl);
      }
    }
  }
}

function queryNonFallbackSlots(roots: PenetrationRoot[]): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const out: HTMLElement[] = [];
  for (const root of roots) {
    const stopAt = rootBoundaryElement(root);
    for (const el of root.querySelectorAll<HTMLElement>(BBI_SLOT_SELECTOR)) {
      if (el.closest?.('.bbm-fallback-slots')) continue;
      if (isHiddenByAncestors(el, stopAt)) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

function collectRawBbmElements(root: PenetrationRoot, stopAt: Element | null, out: Element[]): void {
  for (const el of [...(root.children ?? [])]) {
    if (isChromeOrSlotElement(el)) continue;
    const tag = el.tagName?.toUpperCase?.() ?? '';
    if (SKIP_TAGS.has(tag)) continue;
    if (isHiddenElement(el) || isHiddenByAncestors(el, stopAt)) continue;
    if (tag === 'BBM_IMAGE') {
      out.push(el);
      continue;
    }
    collectRawBbmElements(el, stopAt, out);
  }
}

/**
 * 复原两类未被正则转换的标签残留：
 * 1. 被浏览器直接解析成真实 DOM 元素的 `<bbm_image>`；
 * 2. 被美化正则/脚本转义残留在可见文本节点里的 `<bbm_image>...</bbm_image>` 或 `<div data-bbm-slot...></div>`。
 */
function recoverRawAndEscapedTagNodes(roots: PenetrationRoot[], floorId: number): void {
  for (const root of roots) {
    const doc = (root as Node).ownerDocument || document;
    const stopAt = rootBoundaryElement(root);

    const rawElements: Element[] = [];
    collectRawBbmElements(root, stopAt, rawElements);
    for (const el of rawElements) {
      const slot = createPenetratedSlot(doc, floorId);
      el.parentNode?.replaceChild(slot, el);
    }

    const walker = doc.createTreeWalker(root as unknown as Node, NF_SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName?.toUpperCase?.() ?? '')) {
          return NF_FILTER_REJECT;
        }
        if (parent.closest?.('[data-bbm-slot], .bbm-fallback-slots, .mes_reasoning_details')) {
          return NF_FILTER_REJECT;
        }
        if (isHiddenElement(parent) || isHiddenByAncestors(parent, stopAt)) {
          return NF_FILTER_REJECT;
        }
        return node.nodeValue && /<\/?bbm_image\b|<div\b[^>]*\bdata-bbm-slot\b/i.test(node.nodeValue)
          ? NF_FILTER_ACCEPT
          : NF_FILTER_SKIP;
      },
    });

    const targets: Text[] = [];
    let cur = walker.nextNode();
    while (cur) {
      targets.push(cur as Text);
      cur = walker.nextNode();
    }

    for (const textNode of targets) {
      const val = textNode.nodeValue ?? '';
      const escapedRe =
        /(<bbm_image\b[^>]*>[\s\S]*?<\/bbm_image>|<div\b[^>]*\bdata-bbm-slot\b[^>]*>\s*<\/div>)/gi;
      if (!escapedRe.test(val)) continue;
      escapedRe.lastIndex = 0;

      const frag = doc.createDocumentFragment();
      let cursor = 0;
      for (let m = escapedRe.exec(val); m; m = escapedRe.exec(val)) {
        if (m.index > cursor) {
          frag.appendChild(doc.createTextNode(val.slice(cursor, m.index)));
        }
        frag.appendChild(createPenetratedSlot(doc, floorId));
        cursor = m.index + m[0].length;
      }
      if (cursor < val.length) {
        frag.appendChild(doc.createTextNode(val.slice(cursor)));
      }
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }
}

function isNormalizedEmpty(text: string): boolean {
  return normLen(text) === 0;
}

function hasNormalizedTextInSubtree(node: Node): boolean {
  if (node.nodeType === 3 || !('tagName' in node)) {
    const val = (node as Text).nodeValue;
    return typeof val === 'string' && !isNormalizedEmpty(val);
  }
  const el = node as Element;
  const tag = el.tagName?.toUpperCase?.() ?? '';
  if (SKIP_TAGS.has(tag)) return false;
  if (el.hasAttribute?.('data-bbm-slot')) return false;
  if (isHiddenElement(el)) return false;
  for (const child of [...(el.childNodes ?? [])]) {
    if (hasNormalizedTextInSubtree(child)) return true;
  }
  return false;
}

function hasProseSiblingsInDirection(
  node: Node,
  container: Node,
  direction: 'before' | 'after',
): boolean {
  const children = [...(container.childNodes ?? [])];
  const idx = children.indexOf(node as ChildNode);
  if (idx < 0) return false;
  if (direction === 'after') {
    for (let i = idx + 1; i < children.length; i += 1) {
      if (hasNormalizedTextInSubtree(children[i])) return true;
    }
  } else {
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (hasNormalizedTextInSubtree(children[i])) return true;
    }
  }
  return false;
}

function isLeafProseBlock(el: Element): boolean {
  for (const child of [...(el.children ?? [])]) {
    const tag = child.tagName?.toUpperCase?.() ?? '';
    if (NESTED_BLOCK_TAGS.has(tag)) return false;
    if (!isLeafProseBlock(child)) return false;
  }
  return true;
}

function resolveBlockLiftTarget(
  root: PenetrationRoot,
  textNode: Text,
  localOffset: number,
  placeBefore: boolean,
): Element | null {
  const val = textNode.nodeValue ?? '';
  const edgeSlice = placeBefore ? val.slice(0, localOffset) : val.slice(localOffset);
  if (!isNormalizedEmpty(edgeSlice)) return null;

  const direction = placeBefore ? 'before' : 'after';
  let cur: Node = textNode;
  let liftEl: Element | null = null;

  while (cur.parentNode && cur.parentNode !== root) {
    const parent = cur.parentNode;
    if (!('tagName' in parent)) break;
    const parentEl = parent as Element;
    const tag = parentEl.tagName?.toUpperCase?.() ?? '';
    if (tag === 'BODY' || tag === 'HTML') break;
    if (hasProseSiblingsInDirection(cur, parentEl, direction)) break;

    if (INLINE_TAGS.has(tag)) {
      liftEl = parentEl;
      cur = parentEl;
      continue;
    }

    if (BLOCK_LIFT_TAGS.has(tag) || (LEAF_CONTAINER_TAGS.has(tag) && isLeafProseBlock(parentEl))) {
      liftEl = parentEl;
      cur = parentEl;
      if (BLOCK_LIFT_TAGS.has(tag)) break;
      continue;
    }

    break;
  }

  return liftEl;
}

function isSlotElement(node: Node | null | undefined): boolean {
  if (!node || !('tagName' in node)) return false;
  return (node as Element).hasAttribute?.('data-bbm-slot') ?? false;
}

function findNonWhitespaceAdjacent(node: Node, direction: 'before' | 'after'): Node | null {
  const parent = node.parentNode;
  if (!parent) return null;
  const siblings = [...(parent.childNodes ?? [])];
  const idx = siblings.indexOf(node as ChildNode);
  if (idx < 0) return null;
  const step = direction === 'before' ? -1 : 1;
  for (let i = idx + step; i >= 0 && i < siblings.length; i += step) {
    const sib = siblings[i];
    if (!('tagName' in sib)) {
      const txt = (sib as Text).nodeValue ?? '';
      if (!txt.trim()) continue;
      return sib;
    }
    return sib;
  }
  return null;
}

function hasAdjacentExistingSlot(
  root: PenetrationRoot,
  runs: TextRun[],
  charOffset: number,
  placeBefore: boolean,
  claimedSlots: Set<Element>,
): Element | null {
  if (!runs.length) return null;
  let targetRun = runs[runs.length - 1];
  let localOffset = targetRun.node.nodeValue?.length ?? 0;

  for (const run of runs) {
    if (charOffset <= run.end) {
      targetRun = run;
      const len = run.node.nodeValue?.length ?? 0;
      localOffset = Math.max(0, Math.min(len, charOffset - run.start));
      break;
    }
  }

  const direction = placeBefore ? 'before' : 'after';
  const liftEl = resolveBlockLiftTarget(root, targetRun.node, localOffset, placeBefore);
  const probeNode: Node = liftEl ?? targetRun.node;
  const adj = findNonWhitespaceAdjacent(probeNode, direction);
  if (adj && isSlotElement(adj) && !claimedSlots.has(adj as Element)) {
    return adj as Element;
  }
  if (liftEl && !isSlotElement(adj)) {
    const innerAdj = findNonWhitespaceAdjacent(targetRun.node, direction);
    if (innerAdj && isSlotElement(innerAdj) && !claimedSlots.has(innerAdj as Element)) {
      return innerAdj as Element;
    }
  }
  return null;
}

function insertSlotAtOffset(
  root: PenetrationRoot,
  runs: TextRun[],
  charOffset: number,
  placeBefore: boolean,
  floorId: number,
): HTMLElement | null {
  if (!runs.length) return null;
  let targetRun = runs[runs.length - 1];
  let localOffset = targetRun.node.nodeValue?.length ?? 0;

  for (const run of runs) {
    if (charOffset <= run.end) {
      targetRun = run;
      const len = run.node.nodeValue?.length ?? 0;
      localOffset = Math.max(0, Math.min(len, charOffset - run.start));
      break;
    }
  }

  const doc = targetRun.node.ownerDocument || document;
  const slot = createPenetratedSlot(doc, floorId);

  const liftEl = resolveBlockLiftTarget(root, targetRun.node, localOffset, placeBefore);
  if (liftEl && liftEl.parentNode) {
    if (placeBefore) {
      liftEl.parentNode.insertBefore(slot, liftEl);
    } else {
      const nextSib = findImmediateNextSibling(liftEl);
      liftEl.parentNode.insertBefore(slot, nextSib);
    }
    return slot;
  }

  try {
    const range = doc.createRange();
    range.setStart(targetRun.node, Math.max(0, localOffset));
    range.collapse(true);
    range.insertNode(slot);
    return slot;
  } catch {
    return null;
  }
}

function findImmediateNextSibling(node: Node): Node | null {
  const parent = node.parentNode;
  if (!parent) return null;
  const list = [...(parent.childNodes ?? [])];
  const idx = list.indexOf(node as ChildNode);
  if (idx < 0 || idx + 1 >= list.length) return null;
  return list[idx + 1];
}

function findFallbackBoxes(mesTextEl: HTMLElement, floorId: number): HTMLElement[] {
  const found: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const scan = (container: Element | null) => {
    if (!container) return;
    for (const child of [...(container.children ?? [])]) {
      const isFallback =
        child.classList?.contains?.('bbm-fallback-slots')
        || (typeof child.getAttribute === 'function'
          && child.getAttribute('data-bbm-fallback-floor') === String(floorId));
      if (isFallback && !seen.has(child as HTMLElement)) {
        seen.add(child as HTMLElement);
        found.push(child as HTMLElement);
      }
    }
  };
  scan(mesTextEl);
  scan(mesTextEl.parentElement);
  return found;
}

function applyArmoredFallbackStyle(box: HTMLElement): void {
  const props: Record<string, string> = {
    display: 'flex',
    'flex-direction': 'column',
    gap: '8px',
    'margin-top': '8px',
    visibility: 'visible',
    opacity: '1',
    width: '100%',
    'max-width': '100%',
    height: 'auto',
    'max-height': 'none',
    overflow: 'visible',
    position: 'relative',
  };
  if (typeof box.style?.setProperty === 'function') {
    for (const [k, v] of Object.entries(props)) {
      box.style.setProperty(k, v, 'important');
    }
  } else if (box.style) {
    box.style.cssText = Object.entries(props)
      .map(([k, v]) => `${k}:${v} !important`)
      .join(';');
  }
}

/**
 * 三级渐进式锚点定位与穿透镜：
 * - Level 1：主 `.mes_text` 原生可见 `[data-bbm-slot]`（无美化破坏时零开销直接返回）；
 * - Level 2：递归穿透同源 `<iframe>` / 开放 `ShadowRoot` / 同级美化容器 →
 *            复原裸 `<bbm_image>` 元素与转义槽位 →
 *            `TreeWalker + fuzzyMatchLine` 多锚点模糊定位并块级提权原位插槽；
 * - Level 3：极端美化完全抹除原文时，在可见容器（若 `.mes_text` 被美化隐藏则挂 `.mes_block` 内其紧后方）
 *            幂等挂载带 `!important` 护甲的 `.bbm-fallback-slots` 兜底。
 */
export function resolveFloorAnchors(
  mesTextEl: HTMLElement,
  floorId: number,
  mes: string,
  enablePenetration: boolean,
): HTMLElement[] {
  const tags = parseImageTags(mes);
  if (tags.length === 0) return [];

  // ST 原生 inline_media 隐藏属于宿主有意行为，原样返回原生槽位交由 slotHealth 报 hidden-by-host
  if (mesTextEl.classList?.contains?.(HOST_HIDE_CLASS)) {
    for (const box of findFallbackBoxes(mesTextEl, floorId)) box.remove();
    return [...mesTextEl.querySelectorAll<HTMLElement>(BBI_SLOT_SELECTOR)].filter(
      el => !el.closest?.('.bbm-fallback-slots'),
    );
  }

  const mesTextHidden = isHiddenElement(mesTextEl) || isHiddenByAncestors(mesTextEl);
  // Level 1: 主 .mes_text 可见文本中的纯文本哨兵或 ##bbm_image 标记直接原位物化（不依赖穿透开关）
  if (!mesTextHidden) {
    materializeSentinelTokens([mesTextEl], floorId, false);
    materializeCrossNodeHashTags([mesTextEl], floorId, false);
  }

  const allNativeSlots = [...mesTextEl.querySelectorAll<HTMLElement>(BBI_SLOT_SELECTOR)].filter(
    el => !el.closest?.('.bbm-fallback-slots'),
  );
  const visibleNativeSlots = mesTextHidden
    ? []
    : allNativeSlots.filter(el => !isHiddenByAncestors(el, mesTextEl.parentElement));

  if (!enablePenetration || visibleNativeSlots.length >= tags.length) {
    if (visibleNativeSlots.length >= tags.length) {
      for (const box of findFallbackBoxes(mesTextEl, floorId)) box.remove();
    }
    if (!enablePenetration) {
      return mesTextHidden ? allNativeSlots : visibleNativeSlots;
    }
    return visibleNativeSlots;
  }

  // Level 2: 穿透同源 iframe / Shadow DOM / 同级美化容器 → 物化哨兵与 ##bbm_image → 复原残余标签 → 上下文模糊定位
  const roots = collectCandidateRoots(mesTextEl);
  materializeSentinelTokens(roots, floorId, true);
  materializeCrossNodeHashTags(roots, floorId, true);
  recoverRawAndEscapedTagNodes(roots, floorId);

  let nonFallbackSlots = queryNonFallbackSlots(roots);
  if (nonFallbackSlots.length < tags.length) {
    const anchorsMeta = extractTagAnchors(mes);
    const cursorByRoot = new Map<PenetrationRoot, number>();
    const claimedExisting = new Set<Element>();
    let totalSlots = nonFallbackSlots.length;

    for (let seq = 0; seq < tags.length && totalSlots < tags.length; seq += 1) {
      const meta = anchorsMeta[seq];
      if (!meta) continue;

      let resolved = false;
      for (const root of roots) {
        const { text, runs } = collectLogicalText(root);
        if (!text || !runs.length) continue;
        const startCursor = cursorByRoot.get(root) ?? 0;

        for (const beforeCandidate of meta.anchorsBefore) {
          const hit = fuzzyMatchLine(text, beforeCandidate, startCursor, false);
          if (!hit) continue;
          const existing =
            nonFallbackSlots.length > 0
              ? hasAdjacentExistingSlot(root, runs, hit.end, false, claimedExisting)
              : null;
          if (existing) {
            claimedExisting.add(existing);
            cursorByRoot.set(root, hit.end);
            resolved = true;
            break;
          }
          const inserted = insertSlotAtOffset(root, runs, hit.end, false, floorId);
          if (inserted) {
            claimedExisting.add(inserted);
            cursorByRoot.set(root, hit.end);
            totalSlots += 1;
            resolved = true;
            break;
          }
        }
        if (resolved) break;

        for (const afterCandidate of meta.anchorsAfter) {
          const hitAfter = fuzzyMatchLine(text, afterCandidate, startCursor, true);
          if (!hitAfter) continue;
          const existing =
            nonFallbackSlots.length > 0
              ? hasAdjacentExistingSlot(root, runs, hitAfter.start, true, claimedExisting)
              : null;
          if (existing) {
            claimedExisting.add(existing);
            cursorByRoot.set(root, hitAfter.start);
            resolved = true;
            break;
          }
          const inserted = insertSlotAtOffset(root, runs, hitAfter.start, true, floorId);
          if (inserted) {
            claimedExisting.add(inserted);
            cursorByRoot.set(root, hitAfter.start);
            totalSlots += 1;
            resolved = true;
            break;
          }
        }
        if (resolved) break;
      }
      // 单个 seq 失配不中断，继续为后续图插槽
    }

    nonFallbackSlots = queryNonFallbackSlots(roots);
  }

  // Level 3: 武装兜底容器，保证剩余缺失槽位也绝不丢失
  const missingCount = Math.max(0, tags.length - nonFallbackSlots.length);
  const existingBoxes = findFallbackBoxes(mesTextEl, floorId);

  if (missingCount <= 0) {
    for (const box of existingBoxes) box.remove();
    return nonFallbackSlots;
  }

  const mainDoc = mesTextEl.ownerDocument || document;
  const targetParent =
    mesTextHidden && mesTextEl.parentElement ? mesTextEl.parentElement : mesTextEl;
  let fallbackBox = existingBoxes[0] ?? null;
  for (let i = 1; i < existingBoxes.length; i += 1) {
    existingBoxes[i].remove();
  }

  if (!fallbackBox) {
    fallbackBox = mainDoc.createElement('div');
    fallbackBox.className = 'bbm-fallback-slots';
    fallbackBox.setAttribute('data-bbm-floor', String(floorId));
    fallbackBox.setAttribute('data-bbm-fallback-floor', String(floorId));
  }

  if (fallbackBox.parentNode !== targetParent) {
    if (targetParent !== mesTextEl) {
      targetParent.insertBefore(fallbackBox, findImmediateNextSibling(mesTextEl));
    } else {
      targetParent.appendChild(fallbackBox);
    }
  }
  applyArmoredFallbackStyle(fallbackBox);

  const existingFallback = [...fallbackBox.querySelectorAll<HTMLElement>(BBI_SLOT_SELECTOR)];
  while (existingFallback.length < missingCount) {
    const slot = createPenetratedSlot(mainDoc, floorId);
    fallbackBox.appendChild(slot);
    existingFallback.push(slot);
  }
  while (existingFallback.length > missingCount) {
    const extra = existingFallback.pop();
    extra?.remove();
  }

  return [...nonFallbackSlots, ...existingFallback];
}
