import { describe, expect, it } from 'vitest';
import { IMAGE_TAG_SLOT_SENTINEL } from '@/st/imageTagRegex';
import {
  extractTagAnchors,
  fuzzyMatchLine,
  resolveFloorAnchors,
} from './penetrate';
import { floorIdOf } from './slotHealth';

// 轻量级 Node DOM 模拟（支持 parentElement/children/closest/querySelectorAll/TreeWalker/Range/iframe/ShadowRoot）
class MockNode {
  parentNode: MockNode | null = null;
  childNodes: MockNode[] = [];
  nodeType = 1;
  constructor(public ownerDocument: MockDoc) {}
  get parentElement(): MockEl | null {
    return this.parentNode instanceof MockEl ? this.parentNode : null;
  }
  getRootNode(): MockNode {
    let cur: MockNode = this;
    while (cur.parentNode) cur = cur.parentNode;
    return cur;
  }
  get isConnected(): boolean {
    let cur: MockNode | null = this;
    while (cur) {
      if (cur === this.ownerDocument.body || cur === this.ownerDocument.root) return true;
      if (cur instanceof MockShadowRoot) {
        cur = cur.host;
        continue;
      }
      cur = cur.parentNode;
    }
    return false;
  }
}

class MockText extends MockNode {
  override nodeType = 3;
  constructor(doc: MockDoc, public nodeValue: string) {
    super(doc);
  }
}

class MockShadowRoot extends MockNode {
  override nodeType = 11;
  constructor(doc: MockDoc, public host: MockEl) {
    super(doc);
  }
  get children(): MockEl[] {
    return this.childNodes.filter((n): n is MockEl => n instanceof MockEl);
  }
  appendChild(node: MockNode): MockNode {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node: MockNode, ref: MockNode | null): MockNode {
    const items = node instanceof MockFragment ? [...node.childNodes] : [node];
    if (node instanceof MockFragment) node.childNodes = [];
    const idx = ref ? this.childNodes.indexOf(ref) : -1;
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      it.parentNode = this;
      if (idx >= 0) this.childNodes.splice(idx + i, 0, it);
      else this.childNodes.push(it);
    }
    return node;
  }
  replaceChild(newChild: MockNode, oldChild: MockNode): MockNode {
    const idx = this.childNodes.indexOf(oldChild);
    if (idx < 0) return oldChild;
    const items = newChild instanceof MockFragment ? [...newChild.childNodes] : [newChild];
    if (newChild instanceof MockFragment) newChild.childNodes = [];
    for (const it of items) it.parentNode = this;
    oldChild.parentNode = null;
    this.childNodes.splice(idx, 1, ...items);
    return oldChild;
  }
  querySelectorAll(sel: string): MockEl[] {
    const out: MockEl[] = [];
    const walk = (el: MockEl | MockShadowRoot) => {
      for (const child of el.children) {
        if (child.matchesSimple(sel)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

class MockFragment extends MockNode {
  appendChild(node: MockNode): MockNode {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node: MockNode, ref: MockNode | null): MockNode {
    const items = node instanceof MockFragment ? [...node.childNodes] : [node];
    if (node instanceof MockFragment) node.childNodes = [];
    const idx = ref ? this.childNodes.indexOf(ref) : -1;
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      it.parentNode = this;
      if (idx >= 0) this.childNodes.splice(idx + i, 0, it);
      else this.childNodes.push(it);
    }
    return node;
  }
}

class MockEl extends MockNode {
  tagName: string;
  attrs = new Map<string, string>();
  style: { cssText: string; display?: string; visibility?: string; setProperty?: (k: string, v: string, p?: string) => void } = {
    cssText: '',
  };
  contentDocument: MockDoc | null = null;
  shadowRoot: MockShadowRoot | null = null;

  constructor(doc: MockDoc, tag: string) {
    super(doc);
    this.tagName = tag.toUpperCase();
  }
  attachShadow(): MockShadowRoot {
    this.shadowRoot = new MockShadowRoot(this.ownerDocument, this);
    return this.shadowRoot;
  }
  get className(): string {
    return this.attrs.get('class') ?? '';
  }
  set className(val: string) {
    this.attrs.set('class', val);
  }
  get classList() {
    return {
      contains: (cls: string) => this.className.split(/\s+/).includes(cls),
    };
  }
  get children(): MockEl[] {
    return this.childNodes.filter((n): n is MockEl => n instanceof MockEl);
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  appendChild(node: MockNode): MockNode {
    if (node instanceof MockFragment) {
      for (const child of [...node.childNodes]) this.appendChild(child);
      node.childNodes = [];
      return node;
    }
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node: MockNode, ref: MockNode | null): MockNode {
    const items = node instanceof MockFragment ? [...node.childNodes] : [node];
    if (node instanceof MockFragment) node.childNodes = [];
    const idx = ref ? this.childNodes.indexOf(ref) : -1;
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      it.parentNode = this;
      if (idx >= 0) this.childNodes.splice(idx + i, 0, it);
      else this.childNodes.push(it);
    }
    return node;
  }
  replaceChild(newChild: MockNode, oldChild: MockNode): MockNode {
    const idx = this.childNodes.indexOf(oldChild);
    if (idx < 0) return oldChild;
    const items = newChild instanceof MockFragment ? [...newChild.childNodes] : [newChild];
    if (newChild instanceof MockFragment) newChild.childNodes = [];
    for (const it of items) it.parentNode = this;
    oldChild.parentNode = null;
    this.childNodes.splice(idx, 1, ...items);
    return oldChild;
  }
  remove(): void {
    if (!this.parentNode) return;
    const idx = this.parentNode.childNodes.indexOf(this);
    if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
    this.parentNode = null;
  }
  matchesSimple(sel: string): boolean {
    for (const part of sel.split(',').map(s => s.trim())) {
      if (part === 'iframe' && this.tagName === 'IFRAME') return true;
      if (part === 'div[data-bbm-slot]' && this.tagName === 'DIV' && this.hasAttribute('data-bbm-slot')) return true;
      if (part === '[data-bbm-slot]' && this.hasAttribute('data-bbm-slot')) return true;
      if (part.startsWith('.') && this.classList.contains(part.slice(1))) return true;
    }
    return false;
  }
  closest(sel: string): MockEl | null {
    let cur: MockNode | null = this;
    while (cur instanceof MockEl) {
      if (cur.matchesSimple(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  querySelectorAll(sel: string): MockEl[] {
    const out: MockEl[] = [];
    const walk = (el: MockEl) => {
      for (const child of el.children) {
        if (child.matchesSimple(sel)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): MockEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

class MockDoc {
  root: MockEl;
  body: MockEl;
  defaultView: { frameElement?: MockEl } = {};
  constructor(frameEl?: MockEl) {
    this.root = new MockEl(this, 'html');
    this.body = new MockEl(this, 'body');
    this.root.appendChild(this.body);
    if (frameEl) this.defaultView.frameElement = frameEl;
  }
  createElement(tag: string): MockEl {
    const el = new MockEl(this, tag);
    if (tag.toLowerCase() === 'iframe') {
      el.contentDocument = new MockDoc(el);
    }
    return el;
  }
  createTextNode(val: string): MockText {
    return new MockText(this, val);
  }
  createDocumentFragment(): MockFragment {
    return new MockFragment(this);
  }
  createTreeWalker(root: MockEl | MockShadowRoot, _what: number, filter?: { acceptNode: (n: MockNode) => number }) {
    const list: MockText[] = [];
    const collect = (node: MockNode) => {
      for (const child of node.childNodes) {
        if (child instanceof MockText) {
          const decision = filter ? filter.acceptNode(child) : 1;
          if (decision === 1) list.push(child);
        } else if (child instanceof MockEl) {
          collect(child);
        }
      }
    };
    collect(root);
    let idx = 0;
    return {
      nextNode: () => (idx < list.length ? list[idx++] : null),
    };
  }
  createRange() {
    let startNode: MockText | null = null;
    let startOffset = 0;
    let endNode: MockText | null = null;
    let endOffset = 0;
    const flattenText = (root: MockNode): MockText[] => {
      const out: MockText[] = [];
      const walk = (n: MockNode) => {
        for (const ch of n.childNodes) {
          if (ch instanceof MockText) out.push(ch);
          else walk(ch);
        }
      };
      walk(root);
      return out;
    };
    return {
      setStart: (node: MockText, pos: number) => {
        startNode = node;
        startOffset = pos;
      },
      setEnd: (node: MockText, pos: number) => {
        endNode = node;
        endOffset = pos;
      },
      collapse: () => undefined,
      deleteContents: () => {
        if (!startNode || !endNode) return;
        if (startNode === endNode) {
          const val = startNode.nodeValue;
          startNode.nodeValue = val.slice(0, startOffset) + val.slice(endOffset);
          endOffset = startOffset;
          return;
        }
        const root = startNode.getRootNode();
        const allTexts = flattenText(root);
        const sIdx = allTexts.indexOf(startNode);
        const eIdx = allTexts.indexOf(endNode);
        if (sIdx < 0 || eIdx < sIdx) return;
        startNode.nodeValue = startNode.nodeValue.slice(0, startOffset);
        endNode.nodeValue = endNode.nodeValue.slice(endOffset);
        for (let i = sIdx + 1; i < eIdx; i += 1) {
          const mid = allTexts[i];
          const p = mid.parentNode;
          mid.nodeValue = '';
          if (p) {
            const idx = p.childNodes.indexOf(mid);
            if (idx >= 0) p.childNodes.splice(idx, 1);
            mid.parentNode = null;
            if (p instanceof MockEl && p.childNodes.length === 0) {
              p.remove();
            }
          }
        }
        endNode = startNode;
        endOffset = startOffset;
      },
      insertNode: (el: MockEl) => {
        if (!startNode || !startNode.parentNode) return;
        const parent = startNode.parentNode as MockEl;
        const val = startNode.nodeValue;
        const before = val.slice(0, startOffset);
        const after = val.slice(startOffset);
        startNode.nodeValue = before;
        const idx = parent.childNodes.indexOf(startNode);
        parent.childNodes.splice(idx + 1, 0, el);
        el.parentNode = parent;
        if (after) {
          const afterNode = new MockText(this, after);
          afterNode.parentNode = parent;
          parent.childNodes.splice(idx + 2, 0, afterNode);
        }
      },
    };
  }
}

function tagXml(prompt: string): string {
  return `<bbm_image><tag>${prompt}</tag><size>portrait</size></bbm_image>`;
}

describe('beautification penetration (penetrate.ts)', () => {
  it('extracts prose anchors around <bbm_image> tags', () => {
    const mes = `第一段：莉莉丝站在雨中的拱桥上。\n${tagXml('1girl, bridge')}\n第二段：她望向远处的钟楼。`;
    const anchors = extractTagAnchors(mes);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].anchorBefore).toContain('莉莉丝站在雨中的拱桥上');
    expect(anchors[0].anchorAfter).toContain('她望向远处的钟楼');
  });

  it('Level 1 returns native slots directly without creating fallback', () => {
    const doc = new MockDoc();
    const mes = `剧情一。\n${tagXml('1girl')}\n剧情二。`;
    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';
    const p1 = doc.createElement('p');
    p1.appendChild(doc.createTextNode('剧情一。'));
    const nativeSlot = doc.createElement('div');
    nativeSlot.setAttribute('data-bbm-slot', '');
    mesText.appendChild(p1);
    mesText.appendChild(nativeSlot);
    doc.body.appendChild(mesText);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 5, mes, true);
    expect(slots).toHaveLength(1);
    expect(slots[0].getAttribute('data-bbm-penetrated')).toBeNull();
    expect(mesText.querySelector('.bbm-fallback-slots')).toBeNull();
  });

  it('Level 2 recovers literal <bbm_image> text and fuzzy-matches beautified spans', () => {
    const doc = new MockDoc();
    const mes = `夜雨敲打着玻璃窗。\n${tagXml('1girl, window')}\n她轻轻合上了魔导书。\n${tagXml('book, candle')}`;
    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';

    const card = doc.createElement('div');
    card.className = 'fancy-card';
    card.appendChild(doc.createTextNode('夜雨敲打着玻璃窗。'));
    card.appendChild(doc.createTextNode(tagXml('1girl, window')));
    const p2 = doc.createElement('p');
    const b = doc.createElement('b');
    b.appendChild(doc.createTextNode('✦ 她轻轻合上了'));
    const i = doc.createElement('i');
    i.appendChild(doc.createTextNode('魔导书 ✦'));
    p2.appendChild(b);
    p2.appendChild(i);
    card.appendChild(p2);
    mesText.appendChild(card);
    doc.body.appendChild(mesText);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 7, mes, true);
    expect(slots).toHaveLength(2);
    expect(slots[0].getAttribute('data-bbm-penetrated')).toBe('1');
    expect(slots[1].getAttribute('data-bbm-penetrated')).toBe('1');
    expect(floorIdOf(slots[1])).toBe(7);

    // 幂等性：再次运行不会生成重复槽位
    const slots2 = resolveFloorAnchors(mesText as unknown as HTMLElement, 7, mes, true);
    expect(slots2).toHaveLength(2);
  });

  it('Level 2 penetrates same-origin iframe contentDocument and resolves floorIdOf across iframe boundary', () => {
    const mainDoc = new MockDoc();
    const mes = `画廊中的神秘少女。\n${tagXml('1girl, gallery')}\n月光洒在石阶上。`;
    const mesWrap = mainDoc.createElement('div');
    mesWrap.className = 'mes';
    mesWrap.setAttribute('mesid', '9');
    const mesText = mainDoc.createElement('div');
    mesText.className = 'mes_text';
    const iframe = mainDoc.createElement('iframe');
    mesText.appendChild(iframe);
    mesWrap.appendChild(mesText);
    mainDoc.body.appendChild(mesWrap);

    const idoc = iframe.contentDocument!;
    const p1 = idoc.createElement('p');
    p1.appendChild(idoc.createTextNode('画廊中的神秘少女。'));
    const p2 = idoc.createElement('p');
    p2.appendChild(idoc.createTextNode('月光洒在石阶上。'));
    idoc.body.appendChild(p1);
    idoc.body.appendChild(p2);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 9, mes, true);
    expect(slots).toHaveLength(1);
    expect(slots[0].ownerDocument).toBe(idoc);
    expect(floorIdOf(slots[0])).toBe(9);
  });

  it('Level 3 mounts missing slots in .bbm-fallback-slots idempotently when text is completely replaced', () => {
    const doc = new MockDoc();
    const mes = `原文已彻底隐藏。\n${tagXml('1girl')}\n第二张。\n${tagXml('2girls')}`;
    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';
    mesText.appendChild(doc.createElement('svg'));
    doc.body.appendChild(mesText);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 3, mes, true);
    expect(slots).toHaveLength(2);
    const box = mesText.querySelector('.bbm-fallback-slots')!;
    expect(box).not.toBeNull();
    expect(box.querySelectorAll('[data-bbm-slot]')).toHaveLength(2);

    const slots2 = resolveFloorAnchors(mesText as unknown as HTMLElement, 3, mes, true);
    expect(slots2).toHaveLength(2);
    expect(box.querySelectorAll('[data-bbm-slot]')).toHaveLength(2);
  });

  it('respects enablePenetration=false by returning only native slots', () => {
    const doc = new MockDoc();
    const mes = `一段文字。\n${tagXml('1girl')}`;
    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';
    doc.body.appendChild(mesText);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 1, mes, false);
    expect(slots).toHaveLength(0);
    expect(mesText.querySelector('.bbm-fallback-slots')).toBeNull();
  });

  it('fuzzyMatchLine handles punctuation diffs cleanly', () => {
    const hit = fuzzyMatchLine('“你好——世界！”她说道。', '你好世界她说道');
    expect(hit).not.toBeNull();
    const cnDecorHit = fuzzyMatchLine('「✦ 你好世界 ✦」━━ 她说道', '你好世界她说道');
    expect(cnDecorHit).not.toBeNull();
  });

  it('skips hidden native slot in display:none original container and penetrates visible beautified container', () => {
    const doc = new MockDoc();
    const mes = `雪夜下的庭院。\n${tagXml('1girl, snow')}\n她推开了木门。`;
    const mesBlock = doc.createElement('div');
    mesBlock.className = 'mes_block';

    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';
    mesText.style.display = 'none';
    const hiddenNative = doc.createElement('div');
    hiddenNative.setAttribute('data-bbm-slot', '');
    mesText.appendChild(hiddenNative);

    const beautified = doc.createElement('div');
    beautified.className = 'beautified-prose';
    const p1 = doc.createElement('p');
    p1.appendChild(doc.createTextNode('雪夜下的庭院。'));
    const p2 = doc.createElement('p');
    p2.appendChild(doc.createTextNode('她推开了木门。'));
    beautified.appendChild(p1);
    beautified.appendChild(p2);

    mesBlock.appendChild(mesText);
    mesBlock.appendChild(beautified);
    doc.body.appendChild(mesBlock);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 11, mes, true);
    expect(slots).toHaveLength(1);
    expect(slots[0].getAttribute('data-bbm-penetrated')).toBe('1');
    expect(beautified.querySelectorAll('[data-bbm-slot]')).toHaveLength(1);
    // 块级提权：落在 <p> 之外的 beautified 直接子级
    expect(slots[0].parentNode).toBe(beautified);
    expect(beautified.childNodes[1]).toBe(slots[0]);
  });

  it('skips <pre><code> source blocks in TavernHelper messages and penetrates into same-origin iframe', () => {
    const mainDoc = new MockDoc();
    const mes = `星尘洒落在甲板上。\n${tagXml('1girl, starlight')}\n远方传来钟声。`;
    const mesWrap = mainDoc.createElement('div');
    mesWrap.className = 'mes';
    mesWrap.setAttribute('mesid', '4');
    const mesText = mainDoc.createElement('div');
    mesText.className = 'mes_text';

    const pre = mainDoc.createElement('pre');
    const code = mainDoc.createElement('code');
    code.appendChild(mainDoc.createTextNode('星尘洒落在甲板上。'));
    const hiddenSlotInPre = mainDoc.createElement('div');
    hiddenSlotInPre.setAttribute('data-bbm-slot', '');
    code.appendChild(hiddenSlotInPre);
    pre.appendChild(code);

    const iframe = mainDoc.createElement('iframe');
    mesText.appendChild(pre);
    mesText.appendChild(iframe);
    mesWrap.appendChild(mesText);
    mainDoc.body.appendChild(mesWrap);

    const idoc = iframe.contentDocument!;
    const p1 = idoc.createElement('p');
    p1.appendChild(idoc.createTextNode('星尘洒落在甲板上。'));
    const p2 = idoc.createElement('p');
    p2.appendChild(idoc.createTextNode('远方传来钟声。'));
    idoc.body.appendChild(p1);
    idoc.body.appendChild(p2);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 4, mes, true);
    expect(slots).toHaveLength(1);
    expect(slots[0].ownerDocument).toBe(idoc);
    expect(floorIdOf(slots[0])).toBe(4);
    expect(pre.querySelectorAll('[data-bbm-slot]')).toHaveLength(1);
    expect(slots[0]).not.toBe(hiddenSlotInPre);
  });

  it('recovers escaped <div data-bbm-slot> strings and raw <bbm_image> DOM elements', () => {
    const doc = new MockDoc();
    const mes = `第一幕。\n${tagXml('1girl')}\n第二幕。\n${tagXml('2girls')}`;
    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';

    const p1 = doc.createElement('p');
    p1.appendChild(doc.createTextNode('第一幕。<div data-bbm-slot></div>'));
    const rawEl = doc.createElement('bbm_image');
    rawEl.appendChild(doc.createTextNode('2girls'));
    mesText.appendChild(p1);
    mesText.appendChild(rawEl);
    doc.body.appendChild(mesText);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 6, mes, true);
    expect(slots).toHaveLength(2);
    expect(slots[0].getAttribute('data-bbm-penetrated')).toBe('1');
    expect(slots[1].getAttribute('data-bbm-penetrated')).toBe('1');
  });

  it('uses multi-line fallback anchors past short punctuation lines and does not break subsequent slots on miss', () => {
    const doc = new MockDoc();
    const mes = `完全被替换掉的开头\n${tagXml('miss_first')}\n被替换掉的过场甲。\n被替换掉的过场乙。\n她抬起头看着漫天飞雪。\n“……”\n${tagXml('1girl, snow')}\n雪落在了发梢。`;
    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';

    const p1 = doc.createElement('p');
    p1.appendChild(doc.createTextNode('她抬起头看着漫天飞雪。'));
    const p2 = doc.createElement('p');
    p2.appendChild(doc.createTextNode('「……」'));
    const p3 = doc.createElement('p');
    p3.appendChild(doc.createTextNode('雪落在了发梢。'));
    mesText.appendChild(p1);
    mesText.appendChild(p2);
    mesText.appendChild(p3);
    doc.body.appendChild(mesText);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 8, mes, true);
    expect(slots).toHaveLength(2);
    // 第 2 张通过前向多行锚点命中正文原位；第 1 张失配但不中断第 2 张，第 1 张进兜底
    expect(slots[0].getAttribute('data-bbm-penetrated')).toBe('1');
    expect(slots[0].parentNode).toBe(mesText);
    expect(mesText.querySelector('.bbm-fallback-slots')?.querySelectorAll('[data-bbm-slot]')).toHaveLength(1);
  });

  it('lifts inserted slot outside inline <span> and <p> containers', () => {
    const doc = new MockDoc();
    const mes = `「今天天气真好呢。」\n${tagXml('1girl, sky')}\n她笑着说道。`;
    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';

    const p1 = doc.createElement('p');
    const span = doc.createElement('span');
    span.className = 'dialogue';
    span.appendChild(doc.createTextNode('「今天天气真好呢。」'));
    p1.appendChild(span);

    const p2 = doc.createElement('p');
    p2.appendChild(doc.createTextNode('她笑着说道。'));
    mesText.appendChild(p1);
    mesText.appendChild(p2);
    doc.body.appendChild(mesText);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 2, mes, true);
    expect(slots).toHaveLength(1);
    expect(slots[0].parentNode).toBe(mesText);
    expect(span.querySelectorAll('[data-bbm-slot]')).toHaveLength(0);
  });

  it('penetrates nested iframes and open ShadowRoots', () => {
    const mainDoc = new MockDoc();
    const mes = `镜中倒映着古城。\n${tagXml('1girl, mirror')}\n风声穿过长廊。`;
    const mesWrap = mainDoc.createElement('div');
    mesWrap.className = 'mes';
    mesWrap.setAttribute('mesid', '15');
    const mesText = mainDoc.createElement('div');
    mesText.className = 'mes_text';

    const outerFrame = mainDoc.createElement('iframe');
    mesText.appendChild(outerFrame);
    mesWrap.appendChild(mesText);
    mainDoc.body.appendChild(mesWrap);

    const innerDoc = outerFrame.contentDocument!;
    const shadowHost = innerDoc.createElement('div');
    innerDoc.body.appendChild(shadowHost);
    const shadow = shadowHost.attachShadow();
    const p1 = innerDoc.createElement('p');
    p1.appendChild(innerDoc.createTextNode('镜中倒映着古城。'));
    shadow.appendChild(p1);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 15, mes, true);
    expect(slots).toHaveLength(1);
    expect(slots[0].parentNode).toBe(shadow);
  });

  it('mounts Level 3 fallback outside hidden .mes_text onto .mes_block and removes it once beautification renders', () => {
    const doc = new MockDoc();
    const mes = `原文被暂存隐藏。\n${tagXml('1girl')}`;
    const mesBlock = doc.createElement('div');
    mesBlock.className = 'mes_block';
    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';
    mesText.style.display = 'none';
    mesBlock.appendChild(mesText);
    doc.body.appendChild(mesBlock);

    const fallbackSlots = resolveFloorAnchors(mesText as unknown as HTMLElement, 10, mes, true);
    expect(fallbackSlots).toHaveLength(1);
    expect(mesText.querySelector('.bbm-fallback-slots')).toBeNull();
    const box = mesBlock.querySelector('.bbm-fallback-slots');
    expect(box).not.toBeNull();
    expect(box?.getAttribute('data-bbm-fallback-floor')).toBe('10');

    // 异步美化容器稍后渲染完成 → 再次解析自动升回原位并清理兜底
    const beautified = doc.createElement('div');
    beautified.className = 'beautified';
    const p = doc.createElement('p');
    p.appendChild(doc.createTextNode('原文被暂存隐藏。'));
    beautified.appendChild(p);
    mesBlock.appendChild(beautified);

    const upgradedSlots = resolveFloorAnchors(mesText as unknown as HTMLElement, 10, mes, true);
    expect(upgradedSlots).toHaveLength(1);
    expect(mesBlock.querySelector('.bbm-fallback-slots')).toBeNull();
    expect(beautified.querySelectorAll('[data-bbm-slot]')).toHaveLength(1);
  });

  it('Level 1 materializes @@BBMSLOT@@ inside <p> even when enablePenetration=false and strips empty <p> wrapper', () => {
    const doc = new MockDoc();
    const mes = `第一段。\n${tagXml('1girl')}\n第二段。`;
    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';

    const p1 = doc.createElement('p');
    p1.appendChild(doc.createTextNode('第一段。'));
    const pSlot = doc.createElement('p');
    const spanWrap = doc.createElement('span');
    spanWrap.appendChild(doc.createTextNode(IMAGE_TAG_SLOT_SENTINEL));
    pSlot.appendChild(spanWrap);
    const p2 = doc.createElement('p');
    p2.appendChild(doc.createTextNode('第二段。'));

    mesText.appendChild(p1);
    mesText.appendChild(pSlot);
    mesText.appendChild(p2);
    doc.body.appendChild(mesText);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 12, mes, false);
    expect(slots).toHaveLength(1);
    expect(slots[0].getAttribute('data-bbm-penetrated')).toBeNull();
    expect(slots[0].parentNode).toBe(mesText);
    expect(mesText.children).toHaveLength(3);
    expect(mesText.children[1]).toBe(slots[0]);
  });

  it('penetrates TavernHelper .textContent iframe while leaving hidden raw sentinel untouched', () => {
    const mainDoc = new MockDoc();
    const mes = `原文本已被前端卡完全重绘。\n${tagXml('1girl, cyber')}`;
    const mesWrap = mainDoc.createElement('div');
    mesWrap.className = 'mes';
    mesWrap.setAttribute('mesid', '18');
    const mesText = mainDoc.createElement('div');
    mesText.className = 'mes_text';

    const rawHidden = docDiv(mainDoc, 'raw', true);
    rawHidden.appendChild(mainDoc.createTextNode(`原文本已被前端卡完全重绘。\n${IMAGE_TAG_SLOT_SENTINEL}`));
    const iframe = mainDoc.createElement('iframe');
    mesText.appendChild(rawHidden);
    mesText.appendChild(iframe);
    mesWrap.appendChild(mesText);
    mainDoc.body.appendChild(mesWrap);

    // 模拟前端卡把正文完全改写成别的 UI 文本，但保留了纯文本哨兵
    const idoc = iframe.contentDocument!;
    const cardTitle = idoc.createElement('p');
    cardTitle.appendChild(idoc.createTextNode('【全新UI重构面板】'));
    const cardSlotP = idoc.createElement('p');
    cardSlotP.appendChild(idoc.createTextNode(IMAGE_TAG_SLOT_SENTINEL));
    idoc.body.appendChild(cardTitle);
    idoc.body.appendChild(cardSlotP);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 18, mes, true);
    expect(slots).toHaveLength(1);
    expect(slots[0].ownerDocument).toBe(idoc);
    expect(slots[0].parentNode).toBe(idoc.body);
    expect(slots[0].getAttribute('data-bbm-penetrated')).toBe('1');
    expect(floorIdOf(slots[0])).toBe(18);
    // 隐藏原始容器里的哨兵未被破坏
    expect(rawHidden.querySelectorAll('[data-bbm-slot]')).toHaveLength(0);
    expect((rawHidden.childNodes[0] as MockText).nodeValue).toContain(IMAGE_TAG_SLOT_SENTINEL);
  });

  it('lifts inline-end sentinel outside <p> and splits multiple sentinels in one text node', () => {
    const doc = new MockDoc();
    const mes = `第一段。\n${tagXml('1girl')}\n第二段。\n${tagXml('2girls')}\n${tagXml('3girls')}`;
    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';

    const p1 = doc.createElement('p');
    p1.appendChild(doc.createTextNode(`第一段。 ${IMAGE_TAG_SLOT_SENTINEL}`));
    const box = doc.createElement('div');
    box.appendChild(doc.createTextNode(`第二段。${IMAGE_TAG_SLOT_SENTINEL}中间${IMAGE_TAG_SLOT_SENTINEL}结尾`));
    mesText.appendChild(p1);
    mesText.appendChild(box);
    doc.body.appendChild(mesText);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 21, mes, true);
    expect(slots).toHaveLength(3);
    expect((p1.childNodes[0] as MockText).nodeValue).toBe('第一段。');
    expect(slots[0].parentNode).toBe(mesText);
    expect(slots[1].parentNode).toBe(box);
    expect(slots[2].parentNode).toBe(box);
  });

  it('materializes @@BBMSLOT@@ directly inside open ShadowRoot even when prose is rewritten', () => {
    const doc = new MockDoc();
    const mes = `原始剧情。\n${tagXml('1girl')}`;
    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';
    const host = doc.createElement('div');
    mesText.appendChild(host);
    doc.body.appendChild(mesText);

    const shadow = host.attachShadow();
    const p = doc.createElement('p');
    p.appendChild(doc.createTextNode(IMAGE_TAG_SLOT_SENTINEL));
    shadow.appendChild(p);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 22, mes, true);
    expect(slots).toHaveLength(1);
    expect(slots[0].parentNode).toBe(shadow);
    expect(shadow.childNodes).toHaveLength(1);
  });

  it('materializes raw ##bbm_image ... bbm_image## directly in Level 1 even when global regex is bypassed', () => {
    const doc = new MockDoc();
    const rawTag = '##bbm_image {"tag":"1girl, sunset","size":"portrait"} bbm_image##';
    const mes = `前文。\n${rawTag}\n后文。`;
    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';

    const p1 = doc.createElement('p');
    p1.appendChild(doc.createTextNode('前文。'));
    const pTag = doc.createElement('p');
    pTag.appendChild(doc.createTextNode(rawTag));
    const p2 = doc.createElement('p');
    p2.appendChild(doc.createTextNode('后文。'));
    mesText.appendChild(p1);
    mesText.appendChild(pTag);
    mesText.appendChild(p2);
    doc.body.appendChild(mesText);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 30, mes, false);
    expect(slots).toHaveLength(1);
    expect(slots[0].parentNode).toBe(mesText);
    expect(mesText.children).toHaveLength(3);
    expect(mesText.children[1]).toBe(slots[0]);
  });

  it('materializes raw ##bbm_image inside iframe when frontend card reads message.mes directly', () => {
    const mainDoc = new MockDoc();
    const rawTag = '##bbm_image {"tag":"1girl, long_hair","size":"portrait"} bbm_image##';
    const mes = `完全被前端卡重构的正文。\n${rawTag}`;
    const mesWrap = mainDoc.createElement('div');
    mesWrap.className = 'mes';
    mesWrap.setAttribute('mesid', '31');
    const mesText = mainDoc.createElement('div');
    mesText.className = 'mes_text';

    const iframe = mainDoc.createElement('iframe');
    mesText.appendChild(iframe);
    mesWrap.appendChild(mesText);
    mainDoc.body.appendChild(mesWrap);

    const idoc = iframe.contentDocument!;
    const pTitle = idoc.createElement('p');
    pTitle.appendChild(idoc.createTextNode('【独立渲染卡片】'));
    const pTag = idoc.createElement('p');
    pTag.appendChild(idoc.createTextNode(rawTag));
    idoc.body.appendChild(pTitle);
    idoc.body.appendChild(pTag);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 31, mes, true);
    expect(slots).toHaveLength(1);
    expect(slots[0].ownerDocument).toBe(idoc);
    expect(slots[0].parentNode).toBe(idoc.body);
    expect(slots[0].getAttribute('data-bbm-penetrated')).toBe('1');
  });

  it('materializes ##bbm_image split across inline <em> elements via cross-node Range deletion', () => {
    const doc = new MockDoc();
    const rawTag = '##bbm_image {"tag":"long_hair, blue_eyes","size":"portrait"} bbm_image##';
    const mes = `正文。\n${rawTag}`;
    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';

    const pBody = doc.createElement('p');
    pBody.appendChild(doc.createTextNode('正文。'));
    const pSplit = doc.createElement('p');
    pSplit.appendChild(doc.createTextNode('##bbm_image {"tag":"long'));
    const em = doc.createElement('em');
    em.appendChild(doc.createTextNode('hair, blue'));
    pSplit.appendChild(em);
    pSplit.appendChild(doc.createTextNode('eyes","size":"portrait"} bbm_image##'));

    mesText.appendChild(pBody);
    mesText.appendChild(pSplit);
    doc.body.appendChild(mesText);

    const slots = resolveFloorAnchors(mesText as unknown as HTMLElement, 32, mes, true);
    expect(slots).toHaveLength(1);
    expect(slots[0].parentNode).toBe(mesText);
    expect(mesText.children).toHaveLength(2);
    expect(mesText.children[1]).toBe(slots[0]);
  });
});

function docDiv(doc: MockDoc, cls: string, hidden = false): MockEl {
  const el = doc.createElement('div');
  el.className = cls;
  if (hidden) el.style.display = 'none';
  return el;
}
