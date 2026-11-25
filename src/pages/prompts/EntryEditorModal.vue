<script setup lang="ts">
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import ModalMask from '@/components/ModalMask.vue';
import type { PromptEntry, PromptSlotKind } from '@/prompt/types';
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  open: boolean;
  entry: PromptEntry | null;
  readonly?: boolean;
}>();

const emit = defineEmits<{
  (e: 'save', updated: PromptEntry): void;
  (e: 'close'): void;
}>();

const draft = ref<PromptEntry>({
  id: '',
  name: '',
  enabled: true,
  role: 'system',
  entryType: 'normal',
  content: '',
});
const orWordsText = ref('');
const andWordsText = ref('');
const editorTextarea = ref<InstanceType<typeof BbiTextarea> | null>(null);

watch(
  () => [props.open, props.entry] as const,
  ([isOpen, entry]) => {
    if (!isOpen || !entry) return;
    draft.value = JSON.parse(JSON.stringify(entry)) as PromptEntry;
    draft.value.conditions = draft.value.conditions ?? { nl: 'any', comic: 'any', backend: 'any', slotRewrite: 'any' };
    draft.value.trigger = draft.value.trigger ?? { mode: 'always', orWords: [], andWords: [] };
    orWordsText.value = (draft.value.trigger.orWords ?? []).join(', ');
    andWordsText.value = (draft.value.trigger.andWords ?? []).join(', ');
  },
  { immediate: true },
);

const ROLE_OPTIONS = [
  { value: 'system', label: 'system' },
  { value: 'user', label: 'user' },
  { value: 'assistant', label: 'assistant' },
];

const TYPE_OPTIONS = [
  { value: 'normal', label: '普通文本（normal）' },
  { value: 'slot', label: '动态槽位（slot）' },
  { value: 'tool_guide', label: 'ToolCall 引导条目（Mode A 专用）' },
];

const SLOT_OPTIONS: { value: PromptSlotKind; label: string }[] = [
  { value: 'char_card', label: '角色卡设定 ({{char_card}})' },
  { value: 'persona', label: '用户人设 ({{persona}})' },
  { value: 'world_info', label: '世界书参考 ({{world_info}})' },
  { value: 'book_memory', label: '柏宝书记忆 ({{book_memory}})' },
  { value: 'char_library', label: '角色 DNA 库 ({{char_library}})' },
  { value: 'slot_task', label: '单槽重写任务 ({{slot_task}})' },
  { value: 'history', label: '前文上下文 ({{history}})' },
  { value: 'target_text', label: '待生图正文 ({{target_text}})' },
  { value: 'backend_spec', label: '后端画风与 Tag 规范 ({{backend_spec}})' },
  { value: 'protocol_contract', label: '输出协议 ({{protocol_contract}})' },
  { value: 'thinking_guide', label: '思维链清单 ({{thinking_guide}})' },
];

const QUICK_MACROS = [
  '{{char_card}}',
  '{{persona}}',
  '{{world_info}}',
  '{{book_memory}}',
  '{{char_library}}',
  '{{slot_task}}',
  '{{history}}',
  '{{target_label}}',
  '{{target_text}}',
  '{{backend_spec}}',
  '{{protocol_contract}}',
  '{{thinking_guide}}',
  '{{char}}',
  '{{user}}',
  '{{floor}}',
  '{{min_images}}',
  '{{max_images}}',
  '{{roll 100}}',
  '{{getvar::变量名}}',
  '{{getglobalvar::变量名}}',
];

const isHistorySlot = computed(() => draft.value.entryType === 'slot' && draft.value.slotKind === 'history');

function onTypeChange(nextType: string) {
  const t = nextType as PromptEntry['entryType'];
  draft.value.entryType = t;
  if (t === 'slot' && !draft.value.slotKind) {
    draft.value.slotKind = 'world_info';
    if (!draft.value.content.trim()) draft.value.content = '{{world_info}}';
  }
}

function onSlotChange(nextSlot: string) {
  const s = nextSlot as PromptSlotKind;
  draft.value.slotKind = s;
  if (!draft.value.content.trim() || /^\{\{[a-z_]+\}\}$/.test(draft.value.content.trim())) {
    draft.value.content = s === 'target_text' ? '{{target_label}}\n{{target_text}}' : `{{${s}}}`;
  }
}

function insertMacro(macro: string) {
  if (props.readonly) return;
  const area = editorTextarea.value as unknown as { insertAtCursor?: (s: string) => void } | null;
  if (area?.insertAtCursor) {
    area.insertAtCursor(macro);
  } else {
    draft.value.content = `${draft.value.content}${macro}`;
  }
}

function splitWords(raw: string): string[] {
  return raw
    .split(/[\n,，]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function save() {
  if (props.readonly) {
    emit('close');
    return;
  }
  const cloned = JSON.parse(JSON.stringify(draft.value)) as PromptEntry;
  cloned.name = cloned.name.trim() || '未命名条目';
  if (cloned.entryType !== 'slot') {
    delete cloned.slotKind;
    delete cloned.historyMode;
  }
  cloned.trigger = {
    mode: draft.value.trigger?.mode === 'keyword' ? 'keyword' : 'always',
    orWords: splitWords(orWordsText.value),
    andWords: splitWords(andWordsText.value),
  };
  emit('save', cloned);
}
</script>

<template>
  <ModalMask :open="open" @close="emit('close')">
    <div class="bbi-modal bbm-entry-modal">
      <div class="bbi-modal-head">
        <span class="bbi-modal-title">{{ readonly ? '查看提示词条目（内置只读）' : '编辑提示词条目' }}</span>
        <button type="button" class="bbi-btn bbi-btn-sm" @click="emit('close')">关闭</button>
      </div>

      <div class="bbm-modal-body">
        <div class="bbm-grid-2">
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">条目名称</span></div>
            <input v-model="draft.name" class="bbi-input" :disabled="readonly" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">消息角色（role）</span></div>
            <BbiSelect
              :model-value="draft.role"
              :options="ROLE_OPTIONS"
              @update:model-value="!readonly && (draft.role = $event as PromptEntry['role'])"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">条目类型</span></div>
            <BbiSelect
              :model-value="draft.entryType"
              :options="TYPE_OPTIONS"
              @update:model-value="!readonly && onTypeChange($event)"
            />
          </div>
          <div v-if="draft.entryType === 'slot'" class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">绑定槽位（空内容自动跳过）</span></div>
            <BbiSelect
              :model-value="draft.slotKind || 'world_info'"
              :options="SLOT_OPTIONS"
              @update:model-value="!readonly && onSlotChange($event)"
            />
          </div>
        </div>

        <div v-if="isHistorySlot" class="bbi-field">
          <div class="bbi-field-head"><span class="bbi-field-label">上下文渲染方式</span></div>
          <BbiSelect
            :model-value="draft.historyMode || 'block'"
            :options="[
              { value: 'block', label: '合并区块（{{history}} 块，原版风格）' },
              { value: 'turns', label: '逐轮对话（拆成 user / assistant 多条消息）' },
            ]"
            @update:model-value="!readonly && (draft.historyMode = $event as 'block' | 'turns')"
          />
        </div>

        <div class="bbm-grid-4">
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">自然语言条件</span></div>
            <BbiSelect
              :model-value="draft.conditions?.nl || 'any'"
              :options="[
                { value: 'any', label: '不限' },
                { value: 'on', label: '仅开启 NL' },
                { value: 'off', label: '仅关闭 NL' },
              ]"
              @update:model-value="!readonly && (draft.conditions!.nl = $event as 'any' | 'on' | 'off')"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">漫画模式条件</span></div>
            <BbiSelect
              :model-value="draft.conditions?.comic || 'any'"
              :options="[
                { value: 'any', label: '不限' },
                { value: 'on', label: '仅条漫' },
                { value: 'off', label: '仅插画' },
              ]"
              @update:model-value="!readonly && (draft.conditions!.comic = $event as 'any' | 'on' | 'off')"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">图片后端条件</span></div>
            <BbiSelect
              :model-value="draft.conditions?.backend || 'any'"
              :options="[
                { value: 'any', label: '不限' },
                { value: 'nai', label: '仅 NAI' },
                { value: 'comfyui', label: '仅 ComfyUI' },
              ]"
              @update:model-value="!readonly && (draft.conditions!.backend = $event as 'any' | 'nai' | 'comfyui')"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">单槽重写条件</span></div>
            <BbiSelect
              :model-value="draft.conditions?.slotRewrite || 'any'"
              :options="[
                { value: 'any', label: '不限' },
                { value: 'only', label: '仅单槽重写时' },
                { value: 'exclude', label: '单槽重写时跳过' },
              ]"
              @update:model-value="!readonly && (draft.conditions!.slotRewrite = $event as 'any' | 'only' | 'exclude')"
            />
          </div>
        </div>

        <div class="bbm-trigger-box">
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">激活方式（触发器）</span></div>
            <BbiSelect
              :model-value="draft.trigger?.mode || 'always'"
              :options="[
                { value: 'always', label: '常驻激活（always）' },
                { value: 'keyword', label: '关键词触发（keyword）' },
              ]"
              @update:model-value="!readonly && (draft.trigger!.mode = $event as 'always' | 'keyword')"
            />
          </div>
          <div v-if="draft.trigger?.mode === 'keyword'" class="bbm-grid-2">
            <div class="bbi-field">
              <div class="bbi-field-head"><span class="bbi-field-label">OR 触发词（命中任意即过，逗号分隔）</span></div>
              <input v-model="orWordsText" class="bbi-input" :disabled="readonly" placeholder="雨夜, 月光, 森林" />
            </div>
            <div class="bbi-field">
              <div class="bbi-field-head"><span class="bbi-field-label">AND 附加词（须全部命中，可留空）</span></div>
              <input v-model="andWordsText" class="bbi-input" :disabled="readonly" placeholder="战斗, 拔剑" />
            </div>
          </div>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">条目正文（支持 <code v-pre>{{// 注释}}</code> 与 <code v-pre>{{#nl}}...{{/nl}}</code>）</span>
          </div>
          <div class="bbm-macro-bar">
            <button
              v-for="macro in QUICK_MACROS"
              :key="macro"
              type="button"
              class="bbm-macro-chip"
              :disabled="readonly"
              @click="insertMacro(macro)"
            >
              {{ macro }}
            </button>
          </div>
          <BbiTextarea
            ref="editorTextarea"
            :model-value="draft.content"
            :rows="6"
            :max-rows="16"
            mono
            @update:model-value="!readonly && (draft.content = $event)"
          />
        </div>
      </div>

      <div class="bbi-modal-foot">
        <button type="button" class="bbi-btn" @click="emit('close')">取消</button>
        <button type="button" class="bbi-btn bbi-btn-primary" @click="save">
          {{ readonly ? '确定' : '保存条目' }}
        </button>
      </div>
    </div>
  </ModalMask>
</template>

<style scoped>
.bbm-entry-modal {
  width: min(760px, 95vw);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}
.bbm-modal-body {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 4px;
}
.bbm-grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.bbm-grid-4 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
}
.bbm-trigger-box {
  border: 1px solid var(--bbi-line);
  border-radius: 6px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbm-macro-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.bbm-macro-chip {
  font-size: 11px;
  font-family: monospace;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--bbi-line);
  background: var(--bbi-surface);
  color: var(--bbi-text);
  cursor: pointer;
}
.bbm-macro-chip:hover:not(:disabled) {
  border-color: var(--bbi-accent);
}
</style>
