<script setup lang="ts">
import { BACKENDS, settings, type BackendId } from '@/state/settings';
import { computed, ref, watch, type Component } from 'vue';
import ComfyUIPanel from './panels/ComfyUIPanel.vue';
import NaiPanel from './panels/NaiPanel.vue';

const VISIBLE_BACKENDS = BACKENDS;

const TAB_STORAGE_KEY = 'bbm.backend.tab.v1';

function loadViewing(): BackendId | null {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY);
    return VISIBLE_BACKENDS.some(b => b.value === v) ? (v as BackendId) : null;
  } catch {
    return null;
  }
}

// 优先级:上次看的页签 > 当前出图渠道 > 第一个可见页签。
const viewing = ref<BackendId>(
  loadViewing() ??
    (VISIBLE_BACKENDS.some(b => b.value === settings.defaultBackend)
      ? settings.defaultBackend
      : VISIBLE_BACKENDS[0].value),
);

watch(viewing, v => {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, v);
  } catch {
    /* localStorage 不可用时静默 */
  }
});

const PANELS: Record<BackendId, Component> = {
  comfyui: ComfyUIPanel,
  nai: NaiPanel,
};
const activePanel = computed(() => PANELS[viewing.value]);
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">渠道</h2>
      <div class="bbi-segmented" role="tablist" aria-label="生图渠道">
        <button
          v-for="b in VISIBLE_BACKENDS"
          :key="b.value"
          class="bbi-seg"
          :class="{ 'is-on': viewing === b.value }"
          type="button"
          role="tab"
          :aria-selected="viewing === b.value"
          @click="viewing = b.value"
        >
          {{ b.label }}
        </button>
      </div>
    </div>
    <hr class="bbi-rule" />

    <!-- KeepAlive:切换渠道时保留各面板的折叠/输入状态 -->
    <KeepAlive>
      <component :is="activePanel" :key="viewing" />
    </KeepAlive>
  </section>
</template>

<style scoped>
/* 窄屏下标题与渠道分段控件分两行,不挤压 */
.bbi-page-head {
  flex-wrap: wrap;
}
</style>
