<script setup lang="ts">
import Collapsible from '@/components/Collapsible.vue';
import ModalMask from '@/components/ModalMask.vue';
import {
  previewFloorPrompt,
  testRunPromptPreset,
  type PromptPreviewResult,
  type PromptTestRunResult,
} from '@/autoTag/runner';
import type { PromptPreset } from '@/prompt/types';
import { getContext, isAiStoryMessage } from '@/st/context';
import { ref, watch } from 'vue';

const props = defineProps<{
  open: boolean;
  preset: PromptPreset;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const floorInput = ref(0);
const loading = ref(false);
const errorMsg = ref('');
const preview = ref<PromptPreviewResult | null>(null);

const runningTest = ref(false);
const testError = ref('');
const testResult = ref<PromptTestRunResult | null>(null);

function detectLatestAiFloor(): number {
  const chat = getContext()?.chat ?? [];
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    if (isAiStoryMessage(chat[i])) return i;
  }
  return Math.max(0, chat.length - 1);
}

async function refreshPreview() {
  loading.value = true;
  errorMsg.value = '';
  try {
    preview.value = await previewFloorPrompt(floorInput.value, props.preset);
    floorInput.value = preview.value.floor;
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
    preview.value = null;
  } finally {
    loading.value = false;
  }
}

async function runDryTest() {
  runningTest.value = true;
  testError.value = '';
  testResult.value = null;
  try {
    testResult.value = await testRunPromptPreset(floorInput.value, props.preset);
  } catch (e) {
    testError.value = e instanceof Error ? e.message : String(e);
  } finally {
    runningTest.value = false;
  }
}

watch(
  () => props.open,
  isOpen => {
    if (!isOpen) return;
    floorInput.value = detectLatestAiFloor();
    testResult.value = null;
    testError.value = '';
    void refreshPreview();
  },
);
</script>

<template>
  <ModalMask :open="open" @close="emit('close')">
    <div class="bbi-modal bbm-preview-modal">
      <div class="bbi-modal-head">
        <span class="bbi-modal-title">编译预览与试运行 · {{ preset.name }}</span>
        <button type="button" class="bbi-btn bbi-btn-sm" @click="emit('close')">关闭</button>
      </div>

      <div class="bbm-preview-toolbar">
        <label class="bbm-floor-label">
          <span>取样楼层号：</span>
          <input v-model.number="floorInput" type="number" min="0" class="bbi-input bbm-floor-num" />
        </label>
        <button type="button" class="bbi-btn bbi-btn-sm" :disabled="loading" @click="refreshPreview">
          {{ loading ? '编译中…' : '刷新编译预览' }}
        </button>
        <button
          type="button"
          class="bbi-btn bbi-btn-primary bbi-btn-sm"
          :disabled="runningTest || loading"
          @click="runDryTest"
        >
          {{ runningTest ? '正在试运行副 API…' : '试运行 1 次（不写楼层/不出图）' }}
        </button>
      </div>

      <div class="bbm-preview-body">
        <div v-if="errorMsg" class="bbm-alert bbm-alert-err">{{ errorMsg }}</div>

        <template v-if="preview">
          <div class="bbm-stats-bar">
            <span>模式: <b>{{ preview.preset.outputMode }}</b></span>
            <span>激活条目: <b>{{ preview.compile.stats.activeEntries }}/{{ preview.compile.stats.totalEntries }}</b></span>
            <span>估算 Token: <b>≈{{ preview.compile.stats.estimatedTokens }}</b></span>
            <span v-if="preview.compile.stats.matchedTriggers.length">
              命中触发器: <b>{{ preview.compile.stats.matchedTriggers.join('、') }}</b>
            </span>
          </div>

          <div v-if="preview.lintWarnings.length" class="bbm-alert bbm-alert-warn">
            <div v-for="(w, i) in preview.lintWarnings" :key="i">⚠ {{ w }}</div>
          </div>

          <Collapsible title="编译后实际发送的 messages" :open="true">
            <div class="bbm-msg-list">
              <div v-for="(msg, idx) in preview.requestMessages" :key="idx" class="bbm-msg-item">
                <div class="bbm-msg-role">
                  #{{ idx + 1 }} · {{ msg.role }}
                  <span v-if="preview.compile.guideIndices.includes(idx)" class="bbm-guide-badge">ToolCall引导</span>
                </div>
                <pre class="bbm-pre">{{ typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2) }}</pre>
              </div>
            </div>
          </Collapsible>

          <Collapsible v-if="preview.tools?.length" title="附带的 tools / tool_choice 参数预览" :open="false">
            <pre class="bbm-pre">{{ JSON.stringify({ tool_choice: preview.toolChoice, tools: preview.tools }, null, 2) }}</pre>
          </Collapsible>
        </template>

        <div v-if="testError" class="bbm-alert bbm-alert-err">试运行请求失败：{{ testError }}</div>

        <div v-if="testResult" class="bbm-test-result">
          <div v-if="testResult.parseError" class="bbm-alert bbm-alert-err">
            协议校验未通过：{{ testResult.parseError }}
          </div>
          <div v-else-if="testResult.plan" class="bbm-alert bbm-alert-ok">
            解析校验通过！共返回 {{ testResult.plan.images.length }} 个画面，{{ testResult.plan.changes.length }} 条角色档案变更。
          </div>

          <Collapsible title="试运行解码结果（Decoded / Validated Output）" :open="true">
            <pre class="bbm-pre">{{ testResult.decodedText || '(空)' }}</pre>
          </Collapsible>

          <Collapsible v-if="testResult.rawToolCalls?.length" title="原始 tool_calls 返回体" :open="false">
            <pre class="bbm-pre">{{ JSON.stringify(testResult.rawToolCalls, null, 2) }}</pre>
          </Collapsible>
        </div>
      </div>
    </div>
  </ModalMask>
</template>

<style scoped>
.bbm-preview-modal {
  width: min(860px, 96vw);
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbm-preview-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.bbm-floor-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.bbm-floor-num {
  width: 76px;
}
.bbm-preview-body {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbm-stats-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 12px;
  color: var(--bbi-text-2);
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--bbi-line);
}
.bbm-msg-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbm-msg-item {
  border: 1px solid var(--bbi-line);
  border-radius: 6px;
  padding: 8px;
}
.bbm-msg-role {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.bbm-guide-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bbi-accent-soft, rgba(99, 102, 241, 0.14));
  color: var(--bbi-accent);
}
.bbm-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.45;
  max-height: 280px;
  overflow-y: auto;
}
.bbm-alert {
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.45;
}
.bbm-alert-warn {
  border: 1px solid #d97706;
  background: rgba(217, 119, 6, 0.1);
}
.bbm-alert-err {
  border: 1px solid #dc2626;
  background: rgba(220, 38, 38, 0.1);
}
.bbm-alert-ok {
  border: 1px solid #16a34a;
  background: rgba(22, 163, 74, 0.1);
}
.bbm-test-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
