<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Minus, Square, Copy, X } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { desktopRuntime, toggleNativeMaximise } from '@/services/desktop'

const maximised = ref(false)
const ready = ref(false)
let disposed = false

async function updateState() {
  try {
    const { Window } = await desktopRuntime()
    const state = await Window.IsMaximised()
    if (!disposed) maximised.value = state
  } catch {
    // Resize/focus notifications may arrive while the native window is closing.
  }
}

async function control(action: 'minimise' | 'maximise' | 'close') {
  try {
    const { Window } = await desktopRuntime()
    if (action === 'minimise') await Window.Minimise()
    else if (action === 'close') await Window.Close()
    else {
      await toggleNativeMaximise()
      await updateState()
    }
  } catch {
    toast.error('窗口操作失败，请重试')
  }
}

onMounted(async () => {
  try {
    await desktopRuntime()
    if (disposed) return
    ready.value = true
    await updateState()
    if (disposed) return
    // Covers caption double-click, Windows snap, keyboard shortcuts and buttons.
    window.addEventListener('resize', updateState)
    window.addEventListener('focus', updateState)
  } catch {
    toast.error('桌面窗口控制初始化失败')
  }
})
onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('resize', updateState)
  window.removeEventListener('focus', updateState)
})
</script>

<template>
  <div class="native-window-controls" role="group" aria-label="应用窗口控制">
    <button
      type="button"
      aria-label="最小化应用"
      title="最小化"
      :disabled="!ready"
      @click="control('minimise')"
    >
      <Minus aria-hidden="true" />
    </button>
    <button
      type="button"
      :aria-label="maximised ? '还原应用窗口' : '最大化应用'"
      :title="maximised ? '还原' : '最大化'"
      :disabled="!ready"
      @click="control('maximise')"
    >
      <Copy v-if="maximised" aria-hidden="true" />
      <Square v-else aria-hidden="true" />
    </button>
    <button
      type="button"
      class="native-window-close"
      aria-label="关闭应用"
      title="关闭"
      :disabled="!ready"
      @click="control('close')"
    >
      <X aria-hidden="true" />
    </button>
  </div>
</template>
