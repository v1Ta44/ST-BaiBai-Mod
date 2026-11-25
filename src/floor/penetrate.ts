import { BBI_SLOT_SELECTOR, IMAGE_TAG_FIND_REGEX, parseImageTags } from '@/st/imageTagRegex';

export interface TagAnchorMeta {
  seq: number;
  rawTag: string;
  anchorBefore: string;
  anchorAfter: string;
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

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SVG']);

function stripMarkupToProse(raw: string): string {
  return raw
    .replace(/<bbm_image\b[^>]*>[\s\S]*?<\/bbm_image>/gi, '')
    .replace(/<bbi_image\b[^>]*>[\s\S]*?<\/bbi_image>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r\n|\r/g, '\n')
    .trim();
}

/**
 * 从 `message.mes` 原文提取每个 `<bbm_image>` 槽位前后的纯文本锚点线索。
 */
export function extractTagAnchors(mes: string): TagAnchorMeta[] {
  const source = String(mes ?? '');
  const re = new RegExp(IMAGE_TAG_FIND_REGEX.source, 'gi');
  const out: TagAnchorMeta[] = [];
  let seq = 0;

  for (let match = re.exec(source); match; match = re.exec(source)) {
    const rawBefore = source.slice(Math.max(0, match.index - 400), match.index);
    const rawAfter = source.slice(
      match.index + match[0].length,
      Math.min(source.length, match.index + match[0].length + 250),
    );
    const cleanBefore = stripMarkupToProse(rawBefore);
    const linesBefore = cleanBefore
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length >= 2);
    const tailLine = linesBefore[linesBefore.length - 1] ?? cleanBefore;
    const anchorBefore = tailLine.slice(-80).trim();

    const cleanAfter = stripMarkupToProse(rawAfter);
    const linesAfter = cleanAfter
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length >= 2);
    const anchorAfter = (linesAfter[0] ?? cleanAfter).slice(0, 80).trim();

    out.push({
      seq,
      rawTag: match[0],
      anchorBefore,
      anchorAfter,
    });
    seq += 1;
  }

  return out;
}

/**
 * 用 TreeWalker 采集容器内可见文本流及其对应的 DOM Text 节点偏移映射，
 * 跳过 `<script>` / `<style>` / 既有卡片锚点与兜底容器。
 */
const NF_SHOW_TEXT = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4;
const NF_FILTER_ACCEPT = typeof NodeFilter !== 'undefined' ? NodeFilter.FILTER_ACCEPT : 1;
const NF_FILTER_REJECT = typeof NodeFilter !== 'undefined' ? NodeFilter.FILTER_REJECT : 2;
const NF_FILTER_SKIP = typeof NodeFilter !== 'undefined' ? NodeFilter.FILTER_SKIP : 3;

export function collectLogicalText(root: Element): LogicalTextResult {
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, NF_SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NF_FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NF_FILTER_REJECT;
      if (parent.closest('[data-bbm-slot], .bbm-fallback-slots')) {
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

const STRIP_PUNCT_RE = /[\s,.!?;:'"`“”‘’。，！？；：、（）()【】[\]《》—…·~～\-_/\\*#]/;

function buildNormalizedMap(src: string): { norm: string; rawIndices: number[] } {
  let norm = '';
  const rawIndices: number[] = [];
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (STRIP_PUNCT_RE.test(ch)) continue;
    norm += ch.toLowerCase();
    rawIndices.push(i);
  }
  return { norm, rawIndices };
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
 * 在被美化标签/额外空白装饰打散的纯文本中模糊定位原文句段：
 * 1. 先尝试原文精确子串匹配；
 * 2. 再尝试去空白/标点归一化匹配；
 * 3. 最后做 bigram Dice 滑窗相似度匹配（阈值 >= 0.72）。
 */
export function fuzzyMatchLine(
  haystack: string,
  needle: string,
  minStartOffset = 0,
): { start: number; end: number } | null {
  const cleanNeedle = needle.trim();
  if (!haystack || cleanNeedle.length < 2) return null;

  const exactIdx = haystack.indexOf(cleanNeedle, Math.max(0, minStartOffset));
  if (exactIdx >= 0) {
    return { start: exactIdx, end: exactIdx + cleanNeedle.length };
  }

  const tailSlice = cleanNeedle.slice(-24);
  if (tailSlice.length >= 4) {
    const tailIdx = haystack.indexOf(tailSlice, Math.max(0, minStartOffset));
    if (tailIdx >= 0) {
      return { start: tailIdx, end: tailIdx + tailSlice.length };
    }
  }

  const normNeedle = buildNormalizedMap(cleanNeedle).norm;
  if (normNeedle.length < 3) return null;

  const subHay = haystack.slice(Math.max(0, minStartOffset));
  const hayMap = buildNormalizedMap(subHay);
  if (!hayMap.norm) return null;

  const normIdx = hayMap.norm.indexOf(normNeedle);
  if (normIdx >= 0) {
    const start = minStartOffset + hayMap.rawIndices[normIdx];
    const endRaw = hayMap.rawIndices[normIdx + normNeedle.length - 1] + 1;
    return { start, end: minStartOffset + endRaw };
  }

  // 缩短锚点尾段再做归一化精准命中（适配句首被加了前缀编号/徽章的情况）
  if (normNeedle.length > 10) {
    const tailNorm = normNeedle.slice(-10);
    const tIdx = hayMap.norm.indexOf(tailNorm);
    if (tIdx >= 0) {
      const start = minStartOffset + hayMap.rawIndices[tIdx];
      const endRaw = hayMap.rawIndices[tIdx + tailNorm.length - 1] + 1;
      return { start, end: minStartOffset + endRaw };
    }
  }

  // Bigram 滑窗匹配（容忍少量字符被替换或注入）
  const winLen = normNeedle.length;
  if (hayMap.norm.length >= winLen) {
    let bestScore = 0;
    let bestNormStart = -1;
    const step = Math.max(1, Math.floor(winLen / 8));
    for (let i = 0; i <= hayMap.norm.length - winLen; i += step) {
      const slice = hayMap.norm.slice(i, i + winLen);
      const score = diceBigrams(slice, normNeedle);
      if (score > bestScore) {
        bestScore = score;
        bestNormStart = i;
      }
    }
    if (bestScore >= 0.72 && bestNormStart >= 0) {
      const start = minStartOffset + hayMap.rawIndices[bestNormStart];
      const endRaw = hayMap.rawIndices[bestNormStart + winLen - 1] + 1;
      return { start, end: minStartOffset + endRaw };
    }
  }

  return null;
}

/**
 * 收集候选 DOM 根容器：主 `.mes_text` + 所有同源 `<iframe>` 的 `contentDocument.body`。
 */
export function collectCandidateRoots(mesTextEl: HTMLElement): Element[] {
  const roots: Element[] = [mesTextEl];
  const iframes = mesTextEl.querySelectorAll('iframe');
  for (const frame of iframes) {
    try {
      const body = frame.contentDocument?.body;
      if (body) roots.push(body);
    } catch {
      // 跨域 iframe 禁止访问，安全跳过
    }
  }
  return roots;
}

function createPenetratedSlot(doc: Document, floorId: number): HTMLElement {
  const div = doc.createElement('div');
  div.setAttribute('data-bbm-slot', '');
  div.setAttribute('data-bbm-floor', String(floorId));
  div.setAttribute('data-bbm-penetrated', '1');
  return div;
}

function queryNonFallbackSlots(roots: Element[]): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const out: HTMLElement[] = [];
  for (const root of roots) {
    for (const el of root.querySelectorAll<HTMLElement>(BBI_SLOT_SELECTOR)) {
      if (el.closest('.bbm-fallback-slots')) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

/**
 * 把美化正则/HTML转义残留在文本节点中的 `<bbm_image>...</bbm_image>` 原位替换成槽位锚点。
 */
function recoverEscapedTagNodes(roots: Element[], floorId: number): void {
  for (const root of roots) {
    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, NF_SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NF_FILTER_REJECT;
        if (parent.closest('[data-bbm-slot], .bbm-fallback-slots')) return NF_FILTER_REJECT;
        return node.nodeValue && /<\/?bbm_image\b/i.test(node.nodeValue)
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
      const fullTagRe = /<bbm_image\b[^>]*>[\s\S]*?<\/bbm_image>/gi;
      if (!fullTagRe.test(val)) continue;
      fullTagRe.lastIndex = 0;

      const frag = doc.createDocumentFragment();
      let cursor = 0;
      for (let m = fullTagRe.exec(val); m; m = fullTagRe.exec(val)) {
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

function insertSlotAtOffset(
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
  try {
    const range = doc.createRange();
    range.setStart(targetRun.node, placeBefore ? Math.max(0, localOffset) : localOffset);
    range.collapse(true);
    range.insertNode(slot);
    return slot;
  } catch {
    return null;
  }
}

/**
 * 三级渐进式锚点定位与穿透镜：
 * - Level 1：主 `.mes_text` 原生 `[data-bbm-slot]`（无美化破坏时零开销直接返回）；
 * - Level 2：同源 `<iframe>` 内部 `[data-bbm-slot]` → 转义残余 `<bbm_image>` 原位复原 →
 *            `TreeWalker + fuzzyMatchLine` 上下文模糊定位并按 `Range` 原位插槽；
 * - Level 3：极端美化完全抹除原文时，在 `.mes_text` 末尾幂等挂载 `.bbm-fallback-slots` 兜底。
 */
export function resolveFloorAnchors(
  mesTextEl: HTMLElement,
  floorId: number,
  mes: string,
  enablePenetration: boolean,
): HTMLElement[] {
  const tags = parseImageTags(mes);
  if (tags.length === 0) return [];

  // Level 1: 原生 .mes_text 锚点
  const nativeSlots = [...mesTextEl.querySelectorAll<HTMLElement>(BBI_SLOT_SELECTOR)].filter(
    el => !el.closest('.bbm-fallback-slots'),
  );
  if (!enablePenetration || nativeSlots.length >= tags.length) {
    return nativeSlots;
  }

  // Level 2: 穿透同源 iframe、恢复转义 tag、上下文模糊定位
  const roots = collectCandidateRoots(mesTextEl);
  recoverEscapedTagNodes(roots, floorId);

  let nonFallbackSlots = queryNonFallbackSlots(roots);
  if (nonFallbackSlots.length < tags.length) {
    const anchorsMeta = extractTagAnchors(mes);
    const cursorByRoot = new Map<Element, number>();

    for (let seq = nonFallbackSlots.length; seq < tags.length; seq += 1) {
      const meta = anchorsMeta[seq];
      if (!meta) break;

      let inserted: HTMLElement | null = null;
      for (const root of roots) {
        const { text, runs } = collectLogicalText(root);
        if (!text || !runs.length) continue;
        const startCursor = cursorByRoot.get(root) ?? 0;

        if (meta.anchorBefore) {
          const hit = fuzzyMatchLine(text, meta.anchorBefore, startCursor);
          if (hit) {
            inserted = insertSlotAtOffset(runs, hit.end, false, floorId);
            if (inserted) {
              cursorByRoot.set(root, hit.end);
              break;
            }
          }
        }
        if (meta.anchorAfter) {
          const hitAfter = fuzzyMatchLine(text, meta.anchorAfter, startCursor);
          if (hitAfter) {
            inserted = insertSlotAtOffset(runs, hitAfter.start, true, floorId);
            if (inserted) {
              cursorByRoot.set(root, hitAfter.start);
              break;
            }
          }
        }
      }

      if (!inserted) break;
    }

    nonFallbackSlots = queryNonFallbackSlots(roots);
  }

  // Level 3: 兜底容器，保证剩余缺失槽位也绝不丢失
  const missingCount = tags.length - nonFallbackSlots.length;
  let fallbackBox =
    ([...mesTextEl.children].find(c => c.classList?.contains('bbm-fallback-slots')) as HTMLElement | undefined)
    ?? null;

  if (missingCount <= 0) {
    if (fallbackBox) fallbackBox.remove();
    return nonFallbackSlots;
  }

  const mainDoc = mesTextEl.ownerDocument || document;
  if (!fallbackBox) {
    fallbackBox = mainDoc.createElement('div');
    fallbackBox.className = 'bbm-fallback-slots';
    fallbackBox.setAttribute('data-bbm-floor', String(floorId));
    fallbackBox.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:8px;';
    mesTextEl.appendChild(fallbackBox);
  }

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
