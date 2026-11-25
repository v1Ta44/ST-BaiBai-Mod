<script setup lang="ts">
import BbiSelect from '@/components/BbiSelect.vue';
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import {
  executeImport,
  getCurrentDataSnapshot,
  itemKey,
  planImport,
  readOriginalSnapshotFromHost,
  type ConflictStrategy,
  type ImportItem,
  type ImportKind,
  type ImportReport,
  type OriginalSnapshot,
} from '@/sync/baibaiImageImport';
import { computed, ref, watch } from 'vue';

declare const toastr: {
  success: (msg: string, title?: string) => void;
  warning: (msg: string, title?: string) => void;
  error: (msg: string, title?: string) => void;
};

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const GROUPS: readonly { kind: ImportKind; label: string }[] = [
  { kind: 'naiEndpoint', label: 'NAI 接入点' },
  { kind: 'naiArtist', label: 'NAI 画师串' },
  { kind: 'naiVibe', label: 'NAI Vibe' },
  { kind: 'naiPlan', label: 'NAI 出图方案' },
  { kind: 'comfyServer', label: 'ComfyUI 服务器' },
  { kind: 'comfyPromptSet', label: 'ComfyUI 提示词' },
  { kind: 'comfyWorkflow', label: 'ComfyUI 工作流方案' },
  { kind: 'globalChar', label: '全局角色库' },
];

const STRATEGY_OPTIONS: { value: ConflictStrategy; label: string }[] = [
  { value: 'copy', label: '另存为副本' },
  { value: 'overwrite', label: '覆盖' },
  { value: 'skip', label: '跳过' },
];

const snapshot = ref<OriginalSnapshot | null>(null);
const selectedKeys = ref<Set<string>>(new Set());
const strategy = ref<ConflictStrategy>('copy');
const importing = ref(false);
const report = ref<ImportReport | null>(null);

const strategySel = computed<string>({
  get: () => strategy.value,
  set: v => {
    strategy.value = v as ConflictStrategy;
  },
});

function refreshSnapshot(resetSelection = true): void {
  const next = readOriginalSnapshotFromHost();
  snapshot.value = next;
  if (!next) {
    selectedKeys.value = new Set();
    return;
  }
  if (resetSelection) {
    const defaults = new Set<string>();
    for (const item of next.items) {
      if (item.status === 'new' || item.status === 'conflict') {
        defaults.add(itemKey(item.kind, item.id));
      }
    }
    selectedKeys.value = defaults;
  }
}

watch(
  () => props.open,
  isOpen => {
    if (!isOpen) return;
    report.value = null;
    refreshSnapshot(true);
  },
  { immediate: true },
);

const grouped = computed(() => {
  if (!snapshot.value) return [];
  const byKind = new Map<ImportKind, ImportItem[]>();
  for (const item of snapshot.value.items) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item);
    byKind.set(item.kind, list);
  }
  return GROUPS.map(g => {
    const items = byKind.get(g.kind) ?? [];
    const selectedCount = items.filter(it => selectedKeys.value.has(itemKey(it.kind, it.id))).length;
    const hasPending = items.some(it => it.status !== 'same');
    return { ...g, items, selectedCount, hasPending };
  }).filter(g => g.items.length > 0);
});

const plan = computed(() => {
  if (!snapshot.value) return null;
  return planImport(snapshot.value, selectedKeys.value, strategy.value, getCurrentDataSnapshot());
});

const autoAddedText = computed(() => {
  if (!plan.value?.autoAdded.length) return '';
  return plan.value.autoAdded.map(it => it.name).join('、');
});

const reportSummary = computed(() => {
  if (!report.value) return '';
  const parts: string[] = [];
  for (const g of GROUPS) {
    const n = report.value.counts[g.kind];
    if (n > 0) parts.push(`${g.label} ${n}`);
  }
  const head = parts.length ? `已导入：${parts.join('，')}` : '未写入任何条目';
  return report.value.skipped > 0 ? `${head}（跳过 ${report.value.skipped} 项）` : head;
});

function isChecked(item: ImportItem): boolean {
  return selectedKeys.value.has(itemKey(item.kind, item.id));
}

function toggleItem(item: ImportItem): void {
  const key = itemKey(item.kind, item.id);
  const next = new Set(selectedKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  selectedKeys.value = next;
}

function selectGroup(items: ImportItem[], checked: boolean): void {
  const next = new Set(selectedKeys.value);
  for (const item of items) {
    const key = itemKey(item.kind, item.id);
    if (checked) next.add(key);
    else next.delete(key);
  }
  selectedKeys.value = next;
}

function statusLabel(status: ImportItem['status']): string {
  if (status === 'new') return '新增';
  if (status === 'same') return '已存在';
  return '有差异';
}

async function runImport(): Promise<void> {
  if (importing.value || !plan.value || plan.value.ops.length === 0) return;
  importing.value = true;
  report.value = null;
  try {
    const res = await executeImport(plan.value);
    report.value = res;
    if (res.warnings.length) {
      toastr.warning(`导入完成，但有 ${res.warnings.length} 条提示`, '从柏宝绘导入');
    } else {
      toastr.success('已从柏宝绘导入所选数据', '从柏宝绘导入');
    }
    refreshSnapshot(true);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    toastr.error(msg, '导入失败');
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <ModalMask :open="open" @close="emit('close')">
    <div class="bbi-modal bbi-modal-wide" role="dialog" aria-modal="true" aria-label="从柏宝绘导入">
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">从柏宝绘导入</span>
        <button class="bbi-icon-mini" type="button" title="关闭" @click="emit('close')">
          <Icon name="close" />
        </button>
      </header>

      <div v-if="!snapshot" class="bbm-import-empty">
        <p class="bbi-field-hint">未检测到柏宝绘数据（需同一酒馆安装并使用过柏宝绘）</p>
      </div>

      <template v-else>
        <p v-if="!grouped.length" class="bbi-field-hint">柏宝绘里暂无可导入的配置条目。</p>

        <template v-else>
          <div class="bbm-import-strategy">
            <span class="bbi-modal-label">同 ID 已存在且内容不同时</span>
            <BbiSelect v-model="strategySel" :options="STRATEGY_OPTIONS" aria-label="冲突处理策略" />
          </div>
          <p class="bbi-field-hint">角色库按名字匹配，无副本选项（选「另存为副本」时冲突角色将自动跳过）。</p>

          <div class="bbm-import-groups">
            <Collapsible
              v-for="group in grouped"
              :key="group.kind"
              :title="`${group.label} (${group.selectedCount}/${group.items.length})`"
              :open="group.hasPending"
            >
              <div class="bbm-import-group-bar">
                <span class="bbi-field-hint">已选 {{ group.selectedCount }} / {{ group.items.length }}</span>
                <div class="bbm-import-group-btns">
                  <button
                    class="bbi-btn bbi-btn-sm"
                    type="button"
                    :disabled="importing"
                    @click="selectGroup(group.items, true)"
                  >
                    全选
                  </button>
                  <button
                    class="bbi-btn bbi-btn-sm"
                    type="button"
                    :disabled="importing"
                    @click="selectGroup(group.items, false)"
                  >
                    全不选
                  </button>
                </div>
              </div>

              <div class="bbm-import-list">
                <label v-for="item in group.items" :key="item.id" class="bbm-import-row">
                  <input
                    type="checkbox"
                    class="bbi-checkbox"
                    :checked="isChecked(item)"
                    :disabled="importing"
                    @change="toggleItem(item)"
                  />
                  <span class="bbm-import-name">{{ item.name }}</span>
                  <span v-if="item.detail" class="bbm-import-detail">{{ item.detail }}</span>
                  <span class="bbm-import-badge" :class="`is-${item.status}`">
                    {{ statusLabel(item.status) }}
                  </span>
                </label>
              </div>
            </Collapsible>
          </div>

          <p v-if="autoAddedText" class="bbm-import-deps">
            将自动带上依赖：{{ autoAddedText }}
          </p>
        </template>

        <div v-if="report" class="bbm-import-report">
          <p class="bbm-import-report-main">{{ reportSummary }}</p>
          <ul v-if="report.warnings.length" class="bbm-import-warnings">
            <li v-for="(w, i) in report.warnings" :key="i">{{ w }}</li>
          </ul>
        </div>
      </template>

      <footer class="bbi-modal-foot">
        <span class="bbi-modal-foot-spacer"></span>
        <button class="bbi-btn" type="button" :disabled="importing" @click="emit('close')">关闭</button>
        <button
          v-if="snapshot && grouped.length"
          class="bbi-btn bbi-btn-primary"
          type="button"
          :disabled="importing || !plan || plan.ops.length === 0"
          @click="runImport"
        >
          {{ importing ? '导入中…' : `导入所选 (${plan?.ops.length ?? 0})` }}
        </button>
      </footer>
    </div>
  </ModalMask>
</template>

<style scoped>
.bbm-import-empty {
  padding: 16px 0;
}
.bbm-import-strategy {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.bbm-import-groups {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbm-import-group-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.bbm-import-group-btns {
  display: flex;
  gap: 6px;
}
.bbm-import-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bbm-import-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: var(--bbi-radius-sm);
  cursor: pointer;
}
.bbm-import-row:hover {
  background: var(--bbi-surface-2);
}
.bbm-import-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbm-import-detail {
  flex: 0 1 auto;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--bbi-ink-muted);
}
.bbm-import-badge {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: var(--bbi-radius-pill);
  font-size: 11px;
  font-weight: 600;
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-muted);
}
.bbm-import-badge.is-new {
  background: var(--bbi-accent-soft);
  color: var(--bbi-accent);
}
.bbm-import-badge.is-conflict {
  background: var(--bbi-warning-soft);
  color: var(--bbi-warning);
}
.bbm-import-deps {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  font-size: 12px;
  color: var(--bbi-ink-soft);
  line-height: 1.5;
}
.bbm-import-report {
  padding: 8px 10px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  font-size: 12px;
}
.bbm-import-report-main {
  margin: 0;
  color: var(--bbi-ink);
  font-weight: 600;
}
.bbm-import-warnings {
  margin: 6px 0 0;
  padding-left: 16px;
  color: var(--bbi-warning);
}
</style>
