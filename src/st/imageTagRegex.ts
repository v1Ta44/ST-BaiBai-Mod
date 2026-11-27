import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { serializeComicLayout, validateComicLayout, type ComicLayout } from '@/backends/mossLayout';
import { normalizeOrientation, type Orientation } from '@/backends/size';
import { getContext } from '@/st/context';
import type { ComfyKind } from '@/state/settings';

/**
 * 柏宝绘生图 tag 的两条托管正则（DESIGN-FLOOR-UI.md §4）：
 *
 * - bbi-image-tag-slot（markdownOnly）：显示路径把 <bbi_image>…</bbi_image> 整体
 *   替换为空锚点 <div data-bbi-slot=""></div>，提示词永不进 DOM。
 * - bbi-image-tag-hide（promptOnly）：提示词路径把同一 tag 替换为空字符串。
 *
 * 两条规则 find 相同、生效路径互斥（引擎条件 markdownOnly&&isMarkdown 与
 * promptOnly&&isPrompt 不会同时命中），可安全共存。
 */

export const IMAGE_TAG_FIND_REGEX_LITERAL =
  '/(?:##bbm_image[\\s\\S]+?bbm_image##|<bbm_image>[\\s\\S]+?<\\/bbm_image>)/gi';

/** 与托管脚本同源的运行时正则：解析 message.mes 原文里的 tag（同时兼容新版 ##bbm_image 与存量 <bbm_image>）。 */
export const IMAGE_TAG_FIND_REGEX =
  /(?:##bbm_image[\s\S]+?bbm_image##|<bbm_image>[\s\S]+?<\/bbm_image>)/gi;

/** 显示侧纯文本哨兵占位：穿透正文美化/iframe/.textContent 提取，由水合/穿透阶段原位物化为槽位 DOM。 */
export const IMAGE_TAG_SLOT_SENTINEL = '@@BBMSLOT@@';

/** 显示侧锚点 DOM 选择器（锚点只用 data 属性，class 会被 DOMPurify 加 custom- 前缀）。 */
export const BBI_SLOT_SELECTOR = 'div[data-bbm-slot]';

export const IMAGE_TAG_SLOT_REGEX_ID = 'bbm-image-tag-slot';
export const IMAGE_TAG_HIDE_REGEX_ID = 'bbm-image-tag-hide';

// regex_placement：0=MD_DISPLAY(已弃用) / 1=USER_INPUT / 2=AI_OUTPUT / 3=SLASH_COMMAND。
// 显示路径的 placement 随消息类型变化（script.js getRegexPlacement）：
// 用户消息→1,AI 楼层→2,而 **extra.type === 'narrator' 的楼层→3**；
// 提示词路径(script.js Generate)只按 is_user 二选一,只会是 1 或 2。
const PLACEMENT_USER_INPUT = 1;
const PLACEMENT_AI_OUTPUT = 2;
/**
 * 旁白楼(/narrator、/sys 等 extra.type='narrator')的显示 placement。
 *
 * 必须带上它:`/narrator` 造出的楼是 `is_system:false` + `extra.type:'narrator'`,
 * 于是 st/context.ts 的 isAiStoryMessage **认它是剧情楼**——自动 tag 会往里写 tag。
 * 而显示侧 getRegexPlacement 给这种楼派的是 3,只写 [1,2] 的话锚点正则整条不命中:
 * tag 原文不被替换,DOMPurify 剥掉不认识的 `<bbi_image>` 壳、把里面的提示词当正文留下,
 * 用户直接看到一串 danbooru tag,且没有锚点 = 没有卡片。
 * 「tag 永不进 DOM」这条不变式在这一类楼上是破的。
 *
 * 提示词侧那条(hide)同样带上:它是 promptOnly,只在 isPrompt 时生效,而 ST 自己
 * 从不用 (SLASH_COMMAND, isPrompt) 这个组合,故对现有路径是无操作;带上它是为了
 * 「tag 永不进提示词」在第三方也调 getRegexedString 时依然成立——replaceString 是空串,
 * 多覆盖一个 placement 不会有副作用。两条规则 placement 保持一致也更好推理。
 */
const PLACEMENT_SLASH_COMMAND = 3;

const DISPLAY_AND_PROMPT_PLACEMENTS = [
  PLACEMENT_USER_INPUT,
  PLACEMENT_AI_OUTPUT,
  PLACEMENT_SLASH_COMMAND,
];

export interface ManagedRegexScript extends Record<string, unknown> {
  id: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  placement: number[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
}

/** 显示侧：生图 tag → 纯文本哨兵（抗正文美化清洗，水合时原位物化为锚点再渲染 Vue 卡片）。 */
export function imageTagSlotScript(): ManagedRegexScript {
  return {
    id: IMAGE_TAG_SLOT_REGEX_ID,
    scriptName: '柏宝·改 · 生图标签占位',
    findRegex: IMAGE_TAG_FIND_REGEX_LITERAL,
    replaceString: IMAGE_TAG_SLOT_SENTINEL,
    trimStrings: [],
    placement: [...DISPLAY_AND_PROMPT_PLACEMENTS],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };
}

/** 提示词侧：生图 tag → 空串（提示词路径彻底移除，永不外泄）。 */
export function imageTagHideScript(): ManagedRegexScript {
  return {
    id: IMAGE_TAG_HIDE_REGEX_ID,
    scriptName: '柏宝·改 · 隐藏生图标签',
    findRegex: IMAGE_TAG_FIND_REGEX_LITERAL,
    replaceString: '',
    trimStrings: [],
    placement: [...DISPLAY_AND_PROMPT_PLACEMENTS],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };
}

/** 从消息原文按出现顺序解析全部生图 tag；无 tag 返回空数组。 */
export function parseImageTags(mes: string): string[] {
  return mes.match(IMAGE_TAG_FIND_REGEX) ?? [];
}

/**
 * 正文里是否有生图 tag 的痕迹——**含只剩半截的孤立开/闭标签**。
 *
 * **只有这一份**:楼层按钮判断「要不要先弹重新生成确认」与 runner 判断「要不要跳过
 * 已有 tag 的楼」共用它。两侧各写一条正则的后果:按钮那份只认开标签,正文里只剩一个
 * `</bbi_image>` 时按钮以为没 tag(不弹确认、传 replace=false),runner 那份认开也认闭、
 * 于是以为有 tag 而静默放弃——用户看到的就是「按钮点了永远没反应」。
 */
export function hasImageTagTrace(mes: string): boolean {
  return /<\/?bbm_image\b|##bbm_image\b|bbm_image##/i.test(mes ?? '');
}

/**
 * 剔除消息里的全部生图 tag（重新生成前用）。
 * 插件注入的 tag 独占一行（注入形态：行文本 + 换行 + tag），连同前行换行一起删，
 * 恰好还原注入前原文；手写内联 tag 前面没有换行，仅删 tag 本身。
 *
 * 为什么不能直接 `.replace(查找正则, '')`:那条正则是非贪婪的,正文里多出一个半截的
 * `<bbi_image>`(AI 照着上下文模仿只写了一半、或 tag 被别的插件截断)时,它会从这个
 * 残骸一路吃到下一个 `</bbi_image>`,把中间的正文连同后面那条真 tag 一起删掉。
 * 故改为逐 token 扫:闭标签与**最近一个未配对的开标签**成对(整段删),扫完仍落单的
 * 开/闭标签只删自己。残骸必须清干净——留着它,ST 显示侧那条同样非贪婪的锚点正则
 * 会把正文吞进锚点(破图)。
 */
export function stripImageTags(mes: string): string {
  const source = String(mes ?? '');
  // 就地新建:模块级带 /g 的正则实例 lastIndex 有状态,exec 循环不能共用(同 replaceImageTagAt)
  // ##bbm_image 与 <bbm_image> 各自独立配对,绝不串栈
  const tokens = /<\/?bbm_image\b[^>]*>|##bbm_image\b|bbm_image##/gi;
  const ranges: Array<{ start: number; end: number }> = [];
  const xmlOpenStack: Array<{ start: number; end: number }> = [];
  const hashOpenStack: Array<{ start: number; end: number }> = [];
  for (let match = tokens.exec(source); match; match = tokens.exec(source)) {
    const start = match.index;
    const end = start + match[0].length;
    const rawToken = match[0].toLowerCase();
    if (rawToken === '##bbm_image') {
      hashOpenStack.push({ start, end });
    } else if (rawToken === 'bbm_image##') {
      const open = hashOpenStack.pop();
      ranges.push({ start: open ? open.start : start, end });
    } else if (rawToken.startsWith('</')) {
      const open = xmlOpenStack.pop();
      ranges.push({ start: open ? open.start : start, end });
    } else {
      xmlOpenStack.push({ start, end });
    }
  }
  for (const open of xmlOpenStack) ranges.push(open);
  for (const open of hashOpenStack) ranges.push(open);
  if (!ranges.length) return source;

  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    // `O O C C` 这种嵌套下外层区间已经把内层吃掉了,跳过
    if (range.start < cursor) continue;
    out += source.slice(cursor, range.start).replace(/(?:\r\n|\n|\r)$/, '');
    cursor = range.end;
  }
  return out + source.slice(cursor);
}

/**
 * tag / nl / negative 内容里不允许出现的子标签字面量（会污染 bbm_image 内部解析）。
 *
 * 唯一口径：AI 侧(autoTag/protocol.ts 的 sanitizeContent)与手输侧(提示词编辑弹窗)
 * 共用这一份。
 */
export const FORBIDDEN_SUBTAG =
  /<\/?(?:bbm_image|bbi_image|tag|nl|negative|characters|size|type|layout)\b|##bbm_image\b|bbm_image##/i;

/** 文本里是否含 bbi_image 子标签字面量（手输校验用；口径同 AI 侧）。 */
export function containsTagMarkup(text: string): boolean {
  return FORBIDDEN_SUBTAG.test(text);
}

export interface ImageTagContent {
  /** danbooru 短 tag 部分：显式 <tag> 子标签内容，或剔除子标签后的裸文本（存量格式）。 */
  tag: string;
  /** 自然语言部分：<nl> 子标签内容，无则空串。 */
  nl: string;
  /** 本画面动态负面 tag：<negative> 子标签内容，无则空串。 */
  negative: string;
  characters: ImageCharacterPrompt[];
  /** 画幅方向：<size> 子标签内容，无/不可识别则竖屏（存量 tag 即走这条，行为与改动前一致）。 */
  size: Orientation;
  /**
   * tag 类型：<type> 子标签。**缺省 = 插画**——旧楼层的 tag 都没有它,解析时也只在漫画时才设,
   * 故插画 tag 的字段集合与改动前一模一样。类型由插件按当前方案写入,AI 不参与。
   */
  kind?: ComfyKind;
  /**
   * 漫画分镜(kind 为 comic 时):<layout> 子标签里的 JSON。解析不了 / 校验不过 = null,
   * 卡片据此显示「格式损坏」而不是拿半截内容去出图。插画 tag 恒无此字段。
   */
  layout?: ComicLayout | null;
}

/** tag 的类型;没写 <type> 的(全部存量 tag)一律是插画。 */
export function imageTagKind(content: Pick<ImageTagContent, 'kind'>): ComfyKind {
  return content.kind === 'comic' ? 'comic' : 'illustration';
}

function normalizeCharactersList(
  raw: unknown,
  oneLine: (text: string) => string,
): ImageCharacterPrompt[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 32).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const rawItem = item as Record<string, unknown>;
    const name = oneLine(typeof rawItem.name === 'string' ? rawItem.name : '');
    const tag = oneLine(typeof rawItem.tag === 'string' ? rawItem.tag : '');
    const nl = oneLine(typeof rawItem.nl === 'string' ? rawItem.nl : '');
    return name && tag ? [{ name, tag, nl }] : [];
  });
}

function parseLegacyInner(inner: string, oneLine: (text: string) => string): ImageTagContent {
  const sizeMatch = inner.match(/<size>([\s\S]*?)<\/size>/i);
  const size = normalizeOrientation(sizeMatch ? oneLine(sizeMatch[1]) : '');
  const typeMatch = inner.match(/<type>([\s\S]*?)<\/type>/i);
  if (typeMatch && oneLine(typeMatch[1]).toLowerCase() === 'comic') {
    // 漫画 tag 只认 <layout>:其余子标签对它没有意义,也不去猜
    const layoutMatch = inner.match(/<layout>([\s\S]*?)<\/layout>/i);
    let layout: ComicLayout | null = null;
    try {
      layout = layoutMatch ? validateComicLayout(JSON.parse(layoutMatch[1])) : null;
    } catch {
      layout = null;
    }
    return { tag: '', nl: '', negative: '', characters: [], size, kind: 'comic', layout };
  }
  const nlMatch = inner.match(/<nl>([\s\S]*?)<\/nl>/i);
  const nl = nlMatch ? oneLine(nlMatch[1]) : '';
  const negativeMatch = inner.match(/<negative>([\s\S]*?)<\/negative>/i);
  const negative = negativeMatch ? oneLine(negativeMatch[1]) : '';
  const charactersMatch = inner.match(/<characters>([\s\S]*?)<\/characters>/i);
  let characters: ImageCharacterPrompt[] = [];
  if (charactersMatch) {
    try {
      characters = normalizeCharactersList(JSON.parse(charactersMatch[1]), oneLine);
    } catch {
      // Invalid character JSON must not break the otherwise valid Base prompt.
    }
  }
  const withoutSubTags = inner
    .replace(/<type>[\s\S]*?<\/type>/gi, '')
    .replace(/<layout>[\s\S]*?<\/layout>/gi, '')
    .replace(/<nl>[\s\S]*?<\/nl>/gi, '')
    .replace(/<negative>[\s\S]*?<\/negative>/gi, '')
    .replace(/<characters>[\s\S]*?<\/characters>/gi, '')
    .replace(/<size>[\s\S]*?<\/size>/gi, '');
  const explicit = [...withoutSubTags.matchAll(/<tag>([\s\S]*?)<\/tag>/gi)]
    .map(match => oneLine(match[1]))
    .filter(Boolean);
  const bare = oneLine(withoutSubTags.replace(/<tag>[\s\S]*?<\/tag>/gi, ''));
  const tag = [...(bare ? [bare] : []), ...explicit].join(', ');
  return { tag, nl, negative, characters, size };
}

/**
 * 解析 tag 原文，同时支持新版无尖括号格式 `##bbm_image ... bbm_image##` 与存量 `<bbm_image>...</bbm_image>`。
 */
export function parseImageTagContent(raw: string): ImageTagContent {
  // 内容统一折叠成单行:手写 tag 可能跨行,而提示词里换行没有意义
  const oneLine = (text: string) => text.trim().replace(/[\r\n]+/g, ' ');
  const trimmed = raw.trim();
  if (/^##bbm_image\b/i.test(trimmed)) {
    const inner = trimmed
      .replace(/^##bbm_image\b\s*/i, '')
      .replace(/\s*bbm_image##$/i, '')
      .trim();
    if (inner.startsWith('{')) {
      try {
        const parsed = JSON.parse(inner) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const size = normalizeOrientation(
            typeof parsed.size === 'string' ? oneLine(parsed.size) : '',
          );
          if (typeof parsed.type === 'string' && oneLine(parsed.type).toLowerCase() === 'comic') {
            let layout: ComicLayout | null = null;
            try {
              layout = parsed.layout ? validateComicLayout(parsed.layout) : null;
            } catch {
              layout = null;
            }
            return { tag: '', nl: '', negative: '', characters: [], size, kind: 'comic', layout };
          }
          const tag = typeof parsed.tag === 'string' ? oneLine(parsed.tag) : '';
          const nl = typeof parsed.nl === 'string' ? oneLine(parsed.nl) : '';
          const negative = typeof parsed.negative === 'string' ? oneLine(parsed.negative) : '';
          const characters = normalizeCharactersList(parsed.characters, oneLine);
          return { tag, nl, negative, characters, size };
        }
      } catch {
        // 非法 JSON 回退至容忍式裸文本解析
      }
    }
    return parseLegacyInner(inner, oneLine);
  }

  const inner = raw.replace(/^<bbm_image[^>]*>/i, '').replace(/<\/bbm_image>$/i, '');
  return parseLegacyInner(inner, oneLine);
}

/**
 * 序列化成无尖括号成对标记 `##bbm_image {...} bbm_image##`（抗正文美化/HTML清洗/前端卡绕过正则）。
 */
export function serializeImageTag(content: ImageTagContent): string {
  if (imageTagKind(content) === 'comic') {
    const payload: Record<string, unknown> = { type: 'comic' };
    if (content.layout) {
      payload.layout = JSON.parse(serializeComicLayout(content.layout));
    }
    payload.size = content.size;
    return `##bbm_image ${JSON.stringify(payload)} bbm_image##`;
  }
  const payload: Record<string, unknown> = { tag: content.tag };
  if (content.nl) payload.nl = content.nl;
  if (content.negative) payload.negative = content.negative;
  if (content.characters.length) payload.characters = content.characters;
  payload.size = content.size;
  return `##bbm_image ${JSON.stringify(payload)} bbm_image##`;
}

/**
 * 提示词全文的**唯一展示口径**：楼层卡片（复制 / 灯箱 / 展开区）与图库共用。
 *
 * 与 serializeImageTag 的分工:那个产出机器读的正文原文（会被 promptHash 吃），
 * 这个产出人读的纯文本（段间空行、角色分段）。两者都不许各自照抄第二份——
 * 图库要显示的必须与卡片上一字不差，否则同一张图在两处看到两种样子。
 *
 * size 刻意不出现:它是画幅方向，不是提示词内容，卡片上也从来不显示。
 */
export function formatPromptText(
  content: Pick<ImageTagContent, 'tag' | 'nl' | 'negative' | 'characters' | 'kind' | 'layout'>,
): string {
  if (imageTagKind(content) === 'comic') return formatComicText(content.layout ?? null);
  return [
    content.tag,
    content.nl,
    ...content.characters.map(character =>
      [`角色: ${character.name}`, character.tag, character.nl].filter(Boolean).join('\n'),
    ),
    content.negative ? `Negative: ${content.negative}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 漫画页的人读形态:整页描述一段,下面每个元素一行(角色带库名,对白只显示台词)。 */
function formatComicText(layout: ComicLayout | null): string {
  if (!layout) return '(漫画分镜格式损坏)';
  const lines = layout.items.map(item => {
    if (item.label === 'text') return `[对白] ${item.text ?? ''}`;
    if (item.label === 'object') return `[物体] ${item.caption}`;
    return item.name ? `[角色] ${item.name}: ${item.caption}` : `[角色] ${item.caption}`;
  });
  return [layout.summary, lines.join('\n')].filter(Boolean).join('\n\n');
}

/**
 * 原位替换正文里第 seq 条 tag（0-based），其余正文与其它 tag 一字不动。
 * seq 越界返回 null（调用方据此放弃写回）。
 *
 * 为什么不用模块级的 IMAGE_TAG_FIND_REGEX：那是个带 /g 的共享实例，lastIndex 有状态。
 * 现有调用方走的都是 .match()/.replace()（会重置 lastIndex）故相安无事，
 * 这里用 replace 回调按序计数，仍就地新建正则，不给后来者留下踩踏的余地。
 */
export function replaceImageTagAt(mes: string, seq: number, nextTag: string): string | null {
  if (!Number.isInteger(seq) || seq < 0) return null;
  let index = 0;
  let replaced = false;
  const output = mes.replace(new RegExp(IMAGE_TAG_FIND_REGEX.source, 'gi'), match => {
    if (index++ !== seq) return match;
    replaced = true;
    return nextTag;
  });
  return replaced ? output : null;
}

const MANAGED_SCRIPTS: Array<() => ManagedRegexScript> = [
  imageTagSlotScript,
  imageTagHideScript,
];

/**
 * 向 ST 全局正则列表注册柏宝绘托管规则。
 * 固定 id 保证幂等：旧版本或用户改动过的同 id 规则会被更新，其它正则原样保留，
 * 不重复添加。旧版单条 bbi-image-tag-hide（markdownOnly+promptOnly 双开）会被
 * 新 hide 定义原位覆盖，并新增 slot 规则，存量用户无缝迁移。
 */
export function ensureImageTagRegexRegistered(): boolean {
  const context = getContext();
  const extensionSettings = context?.extensionSettings;
  if (!extensionSettings) return false;
  if (!Array.isArray(extensionSettings.regex)) extensionSettings.regex = [];

  const list = extensionSettings.regex as Array<Record<string, unknown>>;
  for (const make of MANAGED_SCRIPTS) {
    const script = make();
    const index = list.findIndex(item => item?.id === script.id);
    if (script.id === IMAGE_TAG_SLOT_REGEX_ID) {
      // 显示侧占位规则置顶：先于所有全局/局部正文美化正则将 <bbm_image> 替换为纯文本哨兵
      if (index >= 0) {
        const [existing] = list.splice(index, 1);
        list.unshift({ ...existing, ...script });
      } else {
        list.unshift(script);
      }
    } else if (index >= 0) {
      list[index] = { ...list[index], ...script };
    } else {
      list.push(script);
    }
  }
  context.saveSettingsDebounced?.();
  return true;
}
