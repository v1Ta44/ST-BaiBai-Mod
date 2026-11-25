<script setup lang="ts">
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { exportPromptPresetJson, importPromptPresetJson } from '@/prompt/chatu8Import';
import { allPromptPresets, clonePromptPreset, resolvePromptPreset } from '@/prompt/presets';
import type { PromptEntry, PromptPreset } from '@/prompt/types';
import { settings } from '@/state/settings';
import { computed, ref } from 'vue';
import CompilePreviewModal from './CompilePreviewModal.vue';
import EntryEditorModal from './EntryEditorModal.vue';
import ToolCallConfigPanel from './ToolCallConfigPanel.vue';

const presetOptions = computed(() =>
  allPromptPresets(settings.promptPresets).map(p => ({
    value: p.id,
    label: `${p.builtin ? '[内置] ' : ''}${p.name} (${p.outputMode})`,
  })),
);

const currentPreset = computed<PromptPreset>(() =>
  resolvePromptPreset(settings.activePromptPresetId, settings.promptPresets),
);

const isReadonly = computed(() => Boolean(currentPreset.value.builtin));

const OUTPUT_MODE_OPTIONS = [
  { value: 'text_json', label: '文本 JSON 协议（text_json，原版协议，兼容性最广）' },
  { value: 'tool_tunnel', label: 'Tool Calls 隧道（tool_tunnel，防拒绝/智绘姬伪装）' },
  { value: 'tool_structured', label: '原生结构化 Schema Tool（tool_structured，含文本回退）' },
];

const SCOPE_OPTIONS = [
  { value: 'universal', label: '通用（universal）' },
  { value: 'nai', label: 'NovelAI 专用' },
  { value: 'comfy-illust', label: 'ComfyUI 插画专用' },
  { value: 'comfy-comic', label: 'ComfyUI 条漫专用' },
];

function mutateCustomPreset(updater: (p: PromptPreset) => void) {
  const idx = settings.promptPresets.findIndex(p => p.id === currentPreset.value.id);
  if (idx < 0) return;
  const copy = JSON.parse(JSON.stringify(settings.promptPresets[idx])) as PromptPreset;
  updater(copy);
  settings.promptPresets = settings.promptPresets.map((p, i) => (i === idx ? copy : p));
}

function cloneCurrent() {
  const cloned = clonePromptPreset(currentPreset.value, `${currentPreset.value.name} · 副本`);
  cloned.id = `preset_${Date.now().toString(36)}`;
  settings.promptPresets = [...settings.promptPresets, cloned];
  settings.activePromptPresetId = cloned.id;
  toastr.success(`已克隆为可编辑预设「${cloned.name}」`, '柏宝·改');
}

function renameCurrent() {
  if (isReadonly.value) return;
  const next = window.prompt('输入新的预设名称', currentPreset.value.name);
  if (!next || !next.trim()) return;
  mutateCustomPreset(p => {
    p.name = next.trim();
  });
}

function deleteCurrent() {
  if (isReadonly.value) return;
  const targetId = currentPreset.value.id;
  const targetName = currentPreset.value.name;
  settings.promptPresets = settings.promptPresets.filter(p => p.id !== targetId);
  settings.activePromptPresetId = 'builtin_text_json';
  toastr.info(`已删除预设「${targetName}」`, '柏宝·改');
}

// 导入导出
const importOpen = ref(false);
const importJsonText = ref('');
const importError = ref('');
const fileInputEl = ref<HTMLInputElement | null>(null);

function handleExport() {
  const json = exportPromptPresetJson(currentPreset.value);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentPreset.value.name.replace(/[\\/:*?"<>|]/g, '_')}.prompt.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function triggerFileImport() {
  fileInputEl.value?.click();
}

async function onImportFileChange(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  importJsonText.value = await file.text();
  (ev.target as HTMLInputElement).value = '';
}

function confirmImport() {
  importError.value = '';
  try {
    const imported = importPromptPresetJson(importJsonText.value);
    settings.promptPresets = [...settings.promptPresets, ...imported];
    settings.activePromptPresetId = imported[0].id;
    importOpen.value = false;
    importJsonText.value = '';
    toastr.success(`成功导入 ${imported.length} 套提示词预设`, '柏宝·改');
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e);
  }
}

// 条目增删改排序
const editingEntryIndex = ref<number | null>(null);
const editingEntry = ref<PromptEntry | null>(null);
const entryModalOpen = ref(false);

function openEditEntry(idx: number) {
  editingEntryIndex.value = idx;
  editingEntry.value = currentPreset.value.entries[idx];
  entryModalOpen.value = true;
}

function openAddEntry() {
  if (isReadonly.value) return;
  editingEntryIndex.value = null;
  editingEntry.value = {
    id: `entry_${Date.now().toString(36)}`,
    name: '新自定义条目',
    enabled: true,
    role: 'system',
    entryType: 'normal',
    content: '',
    conditions: { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' },
    trigger: { mode: 'always', orWords: [], andWords: [] },
  };
  entryModalOpen.value = true;
}

function saveEntry(updated: PromptEntry) {
  if (isReadonly.value) {
    entryModalOpen.value = false;
    return;
  }
  mutateCustomPreset(p => {
    if (editingEntryIndex.value === null) {
      p.entries.push(updated);
    } else {
      p.entries[editingEntryIndex.value] = updated;
    }
  });
  entryModalOpen.value = false;
}

function toggleEntry(idx: number, enabled: boolean) {
  if (isReadonly.value) return;
  mutateCustomPreset(p => {
    p.entries[idx].enabled = enabled;
  });
}

function moveEntry(idx: number, delta: -1 | 1) {
  if (isReadonly.value) return;
  const target = idx + delta;
  if (target < 0 || target >= currentPreset.value.entries.length) return;
  mutateCustomPreset(p => {
    const [item] = p.entries.splice(idx, 1);
    p.entries.splice(target, 0, item);
  });
}

function deleteEntry(idx: number) {
  if (isReadonly.value) return;
  mutateCustomPreset(p => {
    p.entries.splice(idx, 1);
  });
}

const previewOpen = ref(false);

function summarizeConditions(entry: PromptEntry): string[] {
  const tags: string[] = [];
  const c = entry.conditions;
  if (c?.nl && c.nl !== 'any') tags.push(`NL=${c.nl}`);
  if (c?.comic && c.comic !== 'any') tags.push(c.comic === 'on' ? '仅漫画' : '仅插画');
  if (c?.backend && c.backend !== 'any') tags.push(c.backend);
  if (c?.slotRewrite && c.slotRewrite !== 'any') tags.push(c.slotRewrite === 'only' ? '仅单槽' : '排除单槽');
  if (entry.trigger?.mode === 'keyword') {
    tags.push(`关键词(${entry.trigger.orWords.length}OR/${entry.trigger.andWords.length}AND)`);
  }
  return tags;
}
</script>

<template>
  <div class="bbm-prompts-page">
    <section class="bbm-card">
      <div class="bbm-head-row">
        <div class="bbi-field" style="flex: 1; min-width: 220px;">
          <div class="bbi-field-head">
            <span class="bbi-field-label">当前全局激活预设</span>
            <span class="bbi-field-hint">ComfyUI 工作流可单独覆盖</span>
          </div>
          <BbiSelect
            v-model="settings.activePromptPresetId"
            :options="presetOptions"
          />
        </div>

        <div class="bbm-btn-group">
          <button type="button" class="bbi-btn bbi-btn-sm" @click="cloneCurrent">克隆为自定义</button>
          <button type="button" class="bbi-btn bbi-btn-sm" :disabled="isReadonly" @click="renameCurrent">重命名</button>
          <button type="button" class="bbi-btn bbi-btn-sm" :disabled="isReadonly" @click="deleteCurrent">删除</button>
          <button type="button" class="bbi-btn bbi-btn-sm" @click="importOpen = true">导入 JSON / 智绘姬</button>
          <button type="button" class="bbi-btn bbi-btn-sm" @click="handleExport">导出脱敏 JSON</button>
          <button type="button" class="bbi-btn bbi-btn-primary bbi-btn-sm" @click="previewOpen = true">
            编译预览 / 试运行
          </button>
        </div>
      </div>

      <div v-if="isReadonly" class="bbm-readonly-tip">
        当前选中了只读内置预设，随插件更新自动维护。如需增删条目、修改提示词或调整 Tool Calls 隧道字段，请点击上方「克隆为自定义」。
      </div>

      <div class="bbm-grid-2">
        <div class="bbi-field">
          <div class="bbi-field-head"><span class="bbi-field-label">输出协议模式（outputMode）</span></div>
          <BbiSelect
            :model-value="currentPreset.outputMode"
            :options="OUTPUT_MODE_OPTIONS"
            @update:model-value="!isReadonly && mutateCustomPreset(p => { p.outputMode = $event as PromptPreset['outputMode']; })"
          />
        </div>
        <div class="bbi-field">
          <div class="bbi-field-head"><span class="bbi-field-label">适用范围标签</span></div>
          <BbiSelect
            :model-value="currentPreset.scope"
            :options="SCOPE_OPTIONS"
            @update:model-value="!isReadonly && mutateCustomPreset(p => { p.scope = $event as PromptPreset['scope']; })"
          />
        </div>
      </div>

      <div class="bbm-switches">
        <label class="bbm-check">
          <input
            type="checkbox"
            :disabled="isReadonly"
            :checked="currentPreset.mergeAdjacentSameRole"
            @change="mutateCustomPreset(p => { p.mergeAdjacentSameRole = ($event.target as HTMLInputElement).checked; })"
          />
          <span>合并相邻同角色消息（保留 ToolCall 引导独立边界）</span>
        </label>
        <label class="bbm-check">
          <input
            type="checkbox"
            :disabled="isReadonly"
            :checked="currentPreset.mergeSystemIntoUser"
            @change="mutateCustomPreset(p => { p.mergeSystemIntoUser = ($event.target as HTMLInputElement).checked; })"
          />
          <span>将 system 转为 user（适配不支持多 system 的部分中转/推理模型）</span>
        </label>
      </div>
    </section>

    <ToolCallConfigPanel
      v-if="currentPreset.outputMode === 'tool_tunnel'"
      :model-value="currentPreset.toolCall"
      :readonly="isReadonly"
      @update:model-value="mutateCustomPreset(p => { p.toolCall = $event; })"
    />

    <section class="bbm-card">
      <div class="bbm-head-row">
        <div>
          <div class="bbm-section-title">提示词条目编排（自上而下依次编译）</div>
          <div class="bbi-field-hint" v-pre>支持动态槽位自动空值跳过、{{// 注释}} 剥离、NL 条件段、关键词触发器与只读变量读取</div>
        </div>
        <button v-if="!isReadonly" type="button" class="bbi-btn bbi-btn-primary bbi-btn-sm" @click="openAddEntry">
          + 新增条目
        </button>
      </div>

      <div class="bbm-entry-list">
        <div
          v-for="(entry, idx) in currentPreset.entries"
          :key="entry.id"
          class="bbm-entry-row"
          :class="{ 'is-disabled': !entry.enabled }"
        >
          <input
            type="checkbox"
            :disabled="isReadonly"
            :checked="entry.enabled"
            @change="toggleEntry(idx, ($event.target as HTMLInputElement).checked)"
          />
          <div class="bbm-entry-main" @click="openEditEntry(idx)">
            <div class="bbm-entry-top">
              <span class="bbm-entry-name">{{ entry.name }}</span>
              <span class="bbm-badge">{{ entry.role }}</span>
              <span class="bbm-badge bbm-badge-type">
                {{ entry.entryType === 'slot' ? `slot:${entry.slotKind}` : entry.entryType }}
              </span>
              <span v-for="tag in summarizeConditions(entry)" :key="tag" class="bbm-badge bbm-badge-cond">
                {{ tag }}
              </span>
            </div>
            <div class="bbm-entry-preview">
              {{ entry.content.replace(/\s+/g, ' ').slice(0, 110) || '(空内容)' }}
            </div>
          </div>
          <div class="bbm-entry-actions">
            <button v-if="!isReadonly" type="button" class="bbi-btn bbi-btn-sm" :disabled="idx === 0" @click="moveEntry(idx, -1)">↑</button>
            <button v-if="!isReadonly" type="button" class="bbi-btn bbi-btn-sm" :disabled="idx === currentPreset.entries.length - 1" @click="moveEntry(idx, 1)">↓</button>
            <button type="button" class="bbi-btn bbi-btn-sm" @click="openEditEntry(idx)">
              <Icon name="edit" />
            </button>
            <button v-if="!isReadonly" type="button" class="bbi-btn bbi-btn-sm" @click="deleteEntry(idx)">
              <Icon name="trash" />
            </button>
          </div>
        </div>
      </div>
    </section>

    <EntryEditorModal
      :open="entryModalOpen"
      :entry="editingEntry"
      :readonly="isReadonly"
      @save="saveEntry"
      @close="entryModalOpen = false"
    />

    <CompilePreviewModal
      :open="previewOpen"
      :preset="currentPreset"
      @close="previewOpen = false"
    />

    <ModalMask :open="importOpen" @close="importOpen = false">
      <div class="bbi-modal bbm-import-modal">
        <div class="bbi-modal-head">
          <span class="bbi-modal-title">导入提示词预设（支持本插件格式与智绘姬 test_context_profiles）</span>
          <button type="button" class="bbi-btn bbi-btn-sm" @click="importOpen = false">关闭</button>
        </div>
        <div class="bbm-import-actions">
          <input ref="fileInputEl" type="file" accept=".json,application/json" style="display:none" @change="onImportFileChange" />
          <button type="button" class="bbi-btn bbi-btn-sm" @click="triggerFileImport">选择 JSON 文件</button>
          <span class="bbi-field-hint">或直接在下方粘贴 JSON 文本</span>
        </div>
        <BbiTextarea
          v-model="importJsonText"
          :rows="8"
          :max-rows="18"
          mono
          placeholder='粘贴 { "format": "st-baibai-mod-prompt-v1", ... } 或 智绘姬 test_context_profiles JSON'
        />
        <div v-if="importError" class="bbm-import-err">{{ importError }}</div>
        <div class="bbi-modal-foot">
          <button type="button" class="bbi-btn" @click="importOpen = false">取消</button>
          <button type="button" class="bbi-btn bbi-btn-primary" @click="confirmImport">解析并导入</button>
        </div>
      </div>
    </ModalMask>
  </div>
</template>

<style scoped>
.bbm-prompts-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.bbm-card {
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  padding: 12px;
  background: var(--bbi-surface);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbm-head-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.bbm-btn-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbm-readonly-tip {
  font-size: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bbi-accent-soft, rgba(99, 102, 241, 0.1));
  color: var(--bbi-text-2);
}
.bbm-grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.bbm-switches {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}
.bbm-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}
.bbm-section-title {
  font-weight: 600;
  font-size: 14px;
}
.bbm-entry-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbm-entry-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--bbi-line);
  border-radius: 6px;
  padding: 8px 10px;
}
.bbm-entry-row.is-disabled {
  opacity: 0.55;
}
.bbm-entry-main {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.bbm-entry-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.bbm-entry-name {
  font-weight: 600;
  font-size: 13px;
}
.bbm-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--bbi-line);
  color: var(--bbi-text-2);
}
.bbm-badge-type {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.bbm-badge-cond {
  background: var(--bbi-surface-2, rgba(127, 127, 127, 0.08));
}
.bbm-entry-preview {
  font-size: 12px;
  color: var(--bbi-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}
.bbm-entry-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.bbm-import-modal {
  width: min(640px, 95vw);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbm-import-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bbm-import-err {
  color: #dc2626;
  font-size: 12px;
}
</style>
