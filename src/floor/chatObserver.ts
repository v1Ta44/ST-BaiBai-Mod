/**
 * `#chat` 子树变更的**唯一** MutationObserver。
 *
 * 为什么要共用一个:楼层按钮对账与卡片自愈盯的是同一棵树、同样的 childList+subtree。
 * 各自 new 一个 observer,浏览器就要把同一批 MutationRecord 收集两遍、派发两遍;
 * 而真正的开销在收集侧,不在回调侧。合成一个之后,新增一个订阅者的边际成本
 * 只是回调里多跑一个函数——这也是「加自愈会不会常驻卡顿」的答案:不会,因为
 * 这笔观察成本从楼层按钮上线那天起就已经在付了。
 *
 * 节流用 rAF:流式渲染期间 Mutation 极密(每个 token 一次),同一帧内的连续变更
 * 合并成一次回调。订阅者的回调必须是「便宜的对账」——只读属性、只在真有差异时
 * 才动 DOM,别在里面做全量重建。
 */

type ChatMutationListener = (dirtyFloors: ReadonlySet<number>) => void;

const listeners = new Set<ChatMutationListener>();
const pendingDirtyFloors = new Set<number>();

let observer: MutationObserver | null = null;
let scheduled = false;

function isPluginOwnedNode(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const el = node as Element;
  return Boolean(
    el.hasAttribute?.('data-bbm-slot')
    || el.classList?.contains?.('bbm-fallback-slots')
    || el.classList?.contains?.('bbm-tag-action'),
  );
}

function addFloorFromMes(mes: Element | null | undefined): void {
  const raw = mes?.getAttribute?.('mesid');
  if (raw === null || raw === undefined || raw.trim() === '') return;
  const id = Number(raw);
  if (Number.isInteger(id) && id >= 0) pendingDirtyFloors.add(id);
}

function collectDirtyFloors(records: MutationRecord[]): boolean {
  let hasExternalMutation = false;

  for (const record of records) {
    const hasNodes = record.addedNodes.length > 0 || record.removedNodes.length > 0;
    if (hasNodes) {
      let allPluginOwned = true;
      for (const n of record.addedNodes) {
        if (!isPluginOwnedNode(n)) {
          allPluginOwned = false;
          break;
        }
      }
      if (allPluginOwned) {
        for (const n of record.removedNodes) {
          if (!isPluginOwnedNode(n)) {
            allPluginOwned = false;
            break;
          }
        }
      }
      if (allPluginOwned) continue;
    }

    hasExternalMutation = true;
    const targetEl =
      record.target.nodeType === 1
        ? (record.target as Element)
        : record.target.parentElement;
    const enclosingMes = targetEl?.closest?.('.mes[mesid]');
    if (enclosingMes) {
      addFloorFromMes(enclosingMes);
      continue;
    }

    for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      if (el.classList?.contains?.('mes')) addFloorFromMes(el);
      if (typeof el.querySelectorAll === 'function') {
        for (const childMes of el.querySelectorAll('.mes[mesid]')) {
          addFloorFromMes(childMes);
        }
      }
    }
  }

  return hasExternalMutation;
}

function flush(): void {
  scheduled = false;
  const dirtySnapshot = new Set(pendingDirtyFloors);
  pendingDirtyFloors.clear();

  for (const listener of listeners) {
    // 一个订阅者抛异常不能连坐其它订阅者(尤其别让它把自愈整条链路带走)
    try {
      listener(dirtySnapshot);
    } catch (error) {
      console.error('[柏宝绘] #chat 变更回调异常', error);
    }
  }
}

/**
 * 绑定观察器(幂等)。`#chat` 在 ST 静态模板里,取不到说明宿主环境异常,直接放弃。
 * 返回 false 时调用方**不该**自行退化成轮询:那比 observer 贵得多。
 */
export function ensureChatObserver(): boolean {
  if (observer) return true;
  const chat = document.getElementById('chat');
  if (!chat) return false;

  observer = new MutationObserver(records => {
    if (!collectDirtyFloors(records)) return;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  });
  // 只要 childList+subtree:属性变更(/hide 翻 is_system、我们自己给锚点写 data-theme
  // 与内联样式)一律不进来。后者尤其关键——观察 attributes 会让自愈写属性的动作
  // 反过来唤醒自己,变成自激循环。
  observer.observe(chat, { childList: true, subtree: true });
  return true;
}

/** 订阅 `#chat` 变更(自动确保观察器已绑定)。返回退订函数。 */
export function onChatMutation(listener: ChatMutationListener): () => void {
  listeners.add(listener);
  ensureChatObserver();
  return () => listeners.delete(listener);
}
