<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import WindowFrame from './WindowFrame.vue'
const TerminalPanel = defineAsyncComponent(() => import('./TerminalPanel.vue'))
const LogcatPanel = defineAsyncComponent(() => import('./LogcatPanel.vue'))

const props = defineProps<{
  serial: string
  mode: 'terminal' | 'logcat'
}>()
const emit = defineEmits<{ close: [] }>()
const title = computed(() => ({ terminal: '终端', logcat: 'Logcat' })[props.mode])
const initialSize = computed(() =>
  props.mode === 'logcat' ? { width: 1020, height: 640 } : { width: 860, height: 570 },
)
</script>

<template>
  <WindowFrame
    :id="`developer-${mode}`"
    :title="title"
    class="developer-window"
    titlebar-class="developer-window-toolbar"
    resize-class="file-resize-handle"
    :focus-selector="mode === 'terminal' ? '.xterm-helper-textarea' : undefined"
    :data-testid="`${mode}-window`"
    :geometry="{ size: initialSize, titlebarHeight: 44, mobileFullscreen: true }"
    @close="emit('close')"
  >
    <template #titlebar>
      <strong class="developer-window-title">{{ title }}</strong>
    </template>
    <div
      class="developer-window-content"
      :class="{ 'terminal-window-content': mode === 'terminal' }"
    >
      <TerminalPanel v-if="mode === 'terminal'" :serial="serial" />
      <LogcatPanel v-else :serial="serial" />
    </div>
  </WindowFrame>
</template>
