import { describe, expect, it } from 'vitest';
import {
  extractTagAnchors,
  fuzzyMatchLine,
  resolveFloorAnchors,
} from './penetrate';
import { floorIdOf } from './slotHealth';

// 轻量级 Node DOM 模拟（支持 parentElement/children/closest/querySelectorAll/TreeWalker/Range/iframe）
class MockNode {
  parentNode: MockNode | null = null;
  childNodes: MockNode[] = [];
  constructor(public ownerDocument: MockDoc) {}
  get parentElement(): MockEl | null {
    return this.parentNode instanceof MockEl ? this.parentNode : null;
  }
  get isConnected(): boolean {
    let cur: MockNode | null = this;
    while (cur) {
      if (cur === this.ownerDocument.body || cur === this.ownerDocument.root) return true;
      cur = cur.parentNode;
    }
    return false;
  }
}

class MockText extends MockNode {
  constructor(doc: MockDoc, public nodeValue: string) {
    super(doc);
  }
}

class MockFragment extends MockNode {
  appendChild(node: MockNode): MockNode {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
}

class MockEl extends MockNode {
  tagName: string;
  attrs = new Map<string, string>();
  style: { cssText: string } = { cssText: '' };
  contentDocument: MockDoc | null = null;

  constructor(doc: MockDoc, tag: string) {
    super(doc);
    this.tagName = tag.toUpperCase();
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
  private matchesSimple(sel: string): boolean {
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
  createTreeWalker(root: MockEl, _what: number, filter?: { acceptNode: (n: MockNode) => number }) {
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
    let targetNode: MockText | null = null;
    let offset = 0;
    return {
      setStart: (node: MockText, pos: number) => {
        targetNode = node;
        offset = pos;
      },
      collapse: () => undefined,
      insertNode: (el: MockEl) => {
        if (!targetNode || !targetNode.parentNode) return;
        const parent = targetNode.parentNode as MockEl;
        const val = targetNode.nodeValue;
        const before = val.slice(0, offset);
        const after = val.slice(offset);
        targetNode.nodeValue = before;
        const idx = parent.childNodes.indexOf(targetNode);
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
  });
});
