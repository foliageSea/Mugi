<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Copy, Minus, Square, X } from '@lucide/vue'
import { useWindowGeometry, type WindowGeometryOptions } from '@/composables/useWindowGeometry'
import { useWindowManager } from '@/composables/useWindowManager'
import { useWindowControls } from '@/composables/useWindowControls'

const props = withDefaults(
  defineProps<{
    id: string
    title: string
    geometry?: WindowGeometryOptions
    titlebarClass?: string
    layoutClass?: string
    resizeClass?: string
    focusSelector?: string
    activeLayer?: number
    closing?: boolean
    controlLabel?: string
    zoomLabel?: string
    resizeLabel?: string
    closeOnEscape?: boolean
  }>(),
  {
    geometry: () => ({}),
    activeLayer: 3,
    zoomLabel: '最大化',
  },
)
const emit = defineEmits<{
  close: []
  resize: [size: { width: number; height: number }]
}>()
const root = ref<HTMLElement>()
const manager = useWindowManager()
const { windowControlStyle } = useWindowControls()
const active = computed(() => manager.activeId.value === props.id)
const minimized = computed(() => manager.minimized.value.includes(props.id))
const { rect, fit, start, stop, resizeKey, maximized, toggleMaximize, manipulating } =
  useWindowGeometry(root, () => props.geometry)
const label = computed(() => props.controlLabel ?? `${props.title}窗口`)
const zoomControlLabel = computed(
  () =>
    `${maximized.value ? '还原' : props.zoomLabel}${label.value.endsWith('窗口') ? label.value : `${label.value}窗口`}`,
)

function focus() {
  const target = props.focusSelector
    ? root.value?.querySelector<HTMLElement>(props.focusSelector)
    : root.value
  ;(target || root.value)?.focus({ preventScroll: true })
}
async function fullscreen() {
  stop()
  if (document.fullscreenElement) await document.exitFullscreen()
  else await root.value?.requestFullscreen()
}
function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || !active.value || !props.closeOnEscape)
    return
  if (document.querySelector('[data-slot="dialog-overlay"][data-state="open"]')) return
  event.preventDefault()
  emit('close')
}
function zoom(event: MouseEvent) {
  if ((event.target as HTMLElement).closest('button,a,input,textarea,select,[role=combobox]'))
    return
  toggleMaximize()
}
function resize(event: PointerEvent) {
  manager.activate(props.id)
  start(event, 'resize')
}

watch(minimized, async (value) => {
  if (value) {
    stop()
    if (document.fullscreenElement === root.value) await document.exitFullscreen()
  } else {
    await nextTick()
    fit()
  }
})
watch(
  () => [rect.width, rect.height, props.geometry.aspectRatio],
  () => {
    const width = rect.width - (props.geometry.chrome?.width ?? 0)
    emit('resize', {
      width,
      height: props.geometry.aspectRatio
        ? width / props.geometry.aspectRatio
        : rect.height - (props.geometry.chrome?.height ?? 0),
    })
  },
)
let unregister: (() => void) | undefined
onMounted(() => {
  unregister = manager.register(props.id, { focus, activeLayer: props.activeLayer })
})
onBeforeUnmount(() => unregister?.())
defineExpose({ fullscreen, focus })
</script>

<template>
  <article
    ref="root"
    class="window-frame"
    :class="{
      active,
      closing,
      'window-manipulating': manipulating,
      'window-mobile-fullscreen': geometry.mobileFullscreen,
    }"
    :data-window-id="id"
    :aria-label="title"
    tabindex="-1"
    :style="{
      '--window-x': `${rect.x}px`,
      '--window-y': `${rect.y}px`,
      '--window-width': `${rect.width}px`,
      '--window-height': `${rect.height}px`,
      display: minimized ? 'none' : undefined,
      zIndex: manager.zIndex(id),
    }"
    @pointerdown="manager.activate(id)"
    @focusin="manager.activate(id)"
    @keydown="escape"
  >
    <div class="window-frame-layout" :class="layoutClass">
      <header
        class="window-titlebar"
        :class="[titlebarClass, { 'window-titlebar-windows': windowControlStyle === 'windows' }]"
        @pointerdown="start($event, 'move')"
        @dblclick="zoom"
      >
        <div
          class="window-controls"
          :class="{ 'window-controls-windows': windowControlStyle === 'windows' }"
          aria-label="窗口控制"
          @pointerdown.stop
          @dblclick.stop
        >
          <button
            type="button"
            class="window-control close"
            :disabled="closing"
            :aria-label="`关闭${label}`"
            title="关闭窗口"
            @click.stop="emit('close')"
          >
            <X v-if="windowControlStyle === 'windows'" aria-hidden="true" />
            <span v-else aria-hidden="true">×</span>
          </button>
          <button
            type="button"
            class="window-control minimize"
            :disabled="closing"
            :aria-label="`最小化${label}`"
            title="最小化到 Dock"
            @click.stop="manager.minimizeWindow(id)"
          >
            <Minus v-if="windowControlStyle === 'windows'" aria-hidden="true" />
            <span v-else aria-hidden="true">−</span>
          </button>
          <button
            type="button"
            class="window-control zoom"
            :aria-label="zoomControlLabel"
            :title="maximized ? '还原窗口' : `${zoomLabel}窗口`"
            :aria-pressed="maximized"
            @click.stop="toggleMaximize"
          >
            <template v-if="windowControlStyle === 'windows'">
              <Copy v-if="maximized" aria-hidden="true" />
              <Square v-else aria-hidden="true" />
            </template>
            <span v-else aria-hidden="true">+</span>
          </button>
        </div>
        <slot name="titlebar">
          <strong class="window-caption">{{ title }}</strong>
        </slot>
      </header>
      <slot />
      <button
        v-show="!maximized"
        type="button"
        class="window-resize-handle"
        :class="resizeClass"
        :aria-label="resizeLabel ?? `调节${title}窗口大小`"
        @pointerdown.stop="resize"
        @keydown="resizeKey"
      />
    </div>
  </article>
</template>
