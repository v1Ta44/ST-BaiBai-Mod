<script setup lang="ts">
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Icon from '@/components/Icon.vue';
import { generateSyntheticToolName } from '@/llm/toolCallTransform';
import type { TailMessage, ToolCallPresetConfig, ToolTunnelField } from '@/llm/types';
import { computed } from 'vue';

const props = defineProps<{
  modelValue: ToolCallPresetConfig;
  readonly?: boolean;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', v: ToolCallPresetConfig): void }>();

function patch(partial: Partial<ToolCallPresetConfig>) {
  emit('update:modelValue', { ...props.modelValue, ...partial });
}

const previewName = computed(() =>
  generateSyntheticToolName(
    props.modelValue.prefix,
    props.modelValue.fixedName,
    props.modelValue.nameMode,
  ),
);

const NAME_MODE_OPTIONS = [
  { value: 'dynamic', label: '动态随机后缀（防拦截）' },
  { value: 'fixed', label: '固定函数名' },
];

const TOOL_CHOICE_OPTIONS = [
  { value: 'auto', label: 'auto（模型自主选择）' },
  { value: 'required', label: 'required（强制调工具）' },
  { value: 'function', label: 'function（指定函数名）' },
];

const ROLE_OPTIONS = [
  { value: 'system', label: 'system' },
  { value: 'user', label: 'user' },
  { value: 'assistant', label: 'assistant' },
];

function updateField(index: number, patchField: Partial<ToolTunnelField>) {
  const next = props.modelValue.fields.map((f, i) => (i === index ? { ...f, ...patchField } : f));
  patch({ fields: next });
}

function addField() {
  patch({
    fields: [
      ...props.modelValue.fields,
      { name: 'extra', description: '附加字段', required: false, wrapTag: '' },
    ],
  });
}

function removeField(index: number) {
  patch({ fields: props.modelValue.fields.filter((_, i) => i !== index) });
}

function updateTail(index: number, patchTail: Partial<TailMessage>) {
  const next = props.modelValue.tailMessages.map((t, i) =>
    i === index ? { ...t, ...patchTail } : t,
  );
  patch({ tailMessages: next });
}

function addTail() {
  patch({
    tailMessages: [
      ...props.modelValue.tailMessages,
      {
        id: `tail_${Date.now().toString(36)}`,
        enabled: true,
        role: 'user',
        content: '请立即调用 `%TOOL_NAME%` 提交分析与 JSON 结果。',
      },
    ],
  });
}

function removeTail(index: number) {
  patch({ tailMessages: props.modelValue.tailMessages.filter((_, i) => i !== index) });
}
</script>

<template>
  <div class="bbm-tc-panel">
    <div class="bbm-tc-head">
      <div class="bbm-tc-title">Tool Calls 隧道参数</div>
      <span class="bbm-tc-preview-tag">示例函数名: <code>{{ previewName }}</code></span>
    </div>

    <div class="bbm-grid-2">
      <div class="bbi-field">
        <div class="bbi-field-head"><span class="bbi-field-label">函数命名方式</span></div>
        <BbiSelect
          :model-value="modelValue.nameMode"
          :options="NAME_MODE_OPTIONS"
          @update:model-value="!readonly && patch({ nameMode: $event as 'dynamic' | 'fixed' })"
        />
      </div>

      <div class="bbi-field">
        <div class="bbi-field-head">
          <span class="bbi-field-label">{{ modelValue.nameMode === 'dynamic' ? '随机名前缀' : '固定函数名' }}</span>
        </div>
        <input
          v-if="modelValue.nameMode === 'dynamic'"
          class="bbi-input"
          :disabled="readonly"
          :value="modelValue.prefix"
          @input="patch({ prefix: ($event.target as HTMLInputElement).value })"
        />
        <input
          v-else
          class="bbi-input"
          :disabled="readonly"
          :value="modelValue.fixedName"
          @input="patch({ fixedName: ($event.target as HTMLInputElement).value })"
        />
      </div>

      <div class="bbi-field">
        <div class="bbi-field-head"><span class="bbi-field-label">tool_choice 策略</span></div>
        <BbiSelect
          :model-value="modelValue.toolChoice"
          :options="TOOL_CHOICE_OPTIONS"
          @update:model-value="!readonly && patch({ toolChoice: $event as ToolCallPresetConfig['toolChoice'] })"
        />
      </div>

      <div class="bbi-field">
        <div class="bbi-field-head"><span class="bbi-field-label">隧道封装方式</span></div>
        <label class="bbm-check-line">
          <input
            type="checkbox"
            :disabled="readonly"
            :checked="modelValue.guideWrap"
            @change="patch({ guideWrap: ($event.target as HTMLInputElement).checked })"
          />
          <span>Mode A（引导包裹：将全部非引导条目压缩进 tool.description，隐藏正文消息列表）</span>
        </label>
      </div>
    </div>

    <div v-if="modelValue.guideWrap" class="bbm-subbox">
      <div class="bbi-field">
        <div class="bbi-field-head"><span class="bbi-field-label">档案包裹头（Archive Header）</span></div>
        <input
          class="bbi-input"
          :disabled="readonly"
          :value="modelValue.guideArchiveHeader"
          @input="patch({ guideArchiveHeader: ($event.target as HTMLInputElement).value })"
        />
      </div>
      <div class="bbm-grid-2">
        <div class="bbi-field">
          <div class="bbi-field-head"><span class="bbi-field-label">Mode A 唯一参数名</span></div>
          <input
            class="bbi-input"
            :disabled="readonly"
            :value="modelValue.guideFieldName"
            @input="patch({ guideFieldName: ($event.target as HTMLInputElement).value })"
          />
        </div>
        <div class="bbi-field">
          <div class="bbi-field-head"><span class="bbi-field-label">Mode A 参数说明</span></div>
          <input
            class="bbi-input"
            :disabled="readonly"
            :value="modelValue.guideFieldDesc"
            @input="patch({ guideFieldDesc: ($event.target as HTMLInputElement).value })"
          />
        </div>
      </div>
    </div>

    <template v-else>
      <div class="bbi-field">
        <div class="bbi-field-head"><span class="bbi-field-label">函数描述（支持 %TOOL_NAME%）</span></div>
        <BbiTextarea
          :model-value="modelValue.description"
          :rows="2"
          :max-rows="5"
          @update:model-value="!readonly && patch({ description: $event })"
        />
      </div>

      <div class="bbm-subbox">
        <div class="bbm-row-between">
          <span class="bbi-field-label">Mode B 输出参数字段（按顺序包裹/拼接提取）</span>
          <button v-if="!readonly" type="button" class="bbi-btn bbi-btn-sm" @click="addField">
            + 添加字段
          </button>
        </div>
        <div v-for="(field, idx) in modelValue.fields" :key="idx" class="bbm-field-item">
          <div class="bbm-field-top">
            <input
              class="bbi-input"
              placeholder="字段名 (如 thoughts)"
              :disabled="readonly"
              :value="field.name"
              @input="updateField(idx, { name: ($event.target as HTMLInputElement).value })"
            />
            <input
              class="bbi-input"
              placeholder="可选 XML 标签名 (如 thinking)"
              :disabled="readonly"
              :value="field.wrapTag ?? ''"
              @input="updateField(idx, { wrapTag: ($event.target as HTMLInputElement).value })"
            />
            <label class="bbm-check-inline">
              <input
                type="checkbox"
                :disabled="readonly"
                :checked="field.required"
                @change="updateField(idx, { required: ($event.target as HTMLInputElement).checked })"
              />
              <span>必填</span>
            </label>
            <button
              v-if="!readonly && modelValue.fields.length > 1"
              type="button"
              class="bbi-btn bbi-btn-sm"
              @click="removeField(idx)"
            >
              <Icon name="trash" />
            </button>
          </div>
          <input
            class="bbi-input"
            placeholder="字段说明（description）"
            :disabled="readonly"
            :value="field.description"
            @input="updateField(idx, { description: ($event.target as HTMLInputElement).value })"
          />
        </div>
      </div>

      <div class="bbm-subbox">
        <div class="bbm-row-between">
          <label class="bbm-check-inline">
            <input
              type="checkbox"
              :disabled="readonly"
              :checked="modelValue.enableTailMessages"
              @change="patch({ enableTailMessages: ($event.target as HTMLInputElement).checked })"
            />
            <span class="bbi-field-label">追加尾部诱导消息（Tail Messages）</span>
          </label>
          <button v-if="!readonly && modelValue.enableTailMessages" type="button" class="bbi-btn bbi-btn-sm" @click="addTail">
            + 添加尾部消息
          </button>
        </div>
        <div v-if="modelValue.enableTailMessages" class="bbm-tail-list">
          <div v-for="(tail, idx) in modelValue.tailMessages" :key="tail.id" class="bbm-field-item">
            <div class="bbm-field-top">
              <input
                type="checkbox"
                :disabled="readonly"
                :checked="tail.enabled"
                @change="updateTail(idx, { enabled: ($event.target as HTMLInputElement).checked })"
              />
              <BbiSelect
                :model-value="tail.role"
                :options="ROLE_OPTIONS"
                @update:model-value="!readonly && updateTail(idx, { role: $event as TailMessage['role'] })"
              />
              <button v-if="!readonly" type="button" class="bbi-btn bbi-btn-sm" @click="removeTail(idx)">
                <Icon name="trash" />
              </button>
            </div>
            <BbiTextarea
              :model-value="tail.content"
              :rows="2"
              :max-rows="6"
              placeholder="尾部消息内容（可用 %TOOL_NAME%）"
              @update:model-value="!readonly && updateTail(idx, { content: $event })"
            />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.bbm-tc-panel {
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  padding: 12px;
  background: var(--bbi-surface-2, var(--bbi-surface));
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbm-tc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.bbm-tc-title {
  font-weight: 600;
  font-size: 13px;
}
.bbm-tc-preview-tag {
  font-size: 12px;
  color: var(--bbi-text-2);
}
.bbm-grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.bbm-subbox {
  border-top: 1px dashed var(--bbi-line);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbm-row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.bbm-field-item {
  border: 1px solid var(--bbi-line);
  border-radius: 6px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--bbi-surface);
}
.bbm-field-top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.bbm-field-top > .bbi-input {
  flex: 1;
  min-width: 0;
}
.bbm-check-line {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.4;
}
.bbm-check-inline {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  white-space: nowrap;
}
.bbm-tail-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
