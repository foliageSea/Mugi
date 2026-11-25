import { onBeforeUnmount, onMounted, reactive, ref, watch, type Ref } from 'vue'
import { aspectWindowSize, contentWidthFromDrag } from '@/lib/scrcpy/window-geometry.js'
import { constrainWindowPosition, useWindowGesture } from './useWindowGesture'

export interface WindowGeometryOptions {
  size?: { width: number; height: number }
  minSize?: { width: number; height: number }
  aspectRatio?: number
  chrome?: { width: number; height: number }
  titlebarHeight?: number
  margin?: number
  mobileFullscreen?: boolean
}

export function useWindowGeometry(
  root: Ref<HTMLElement | undefined>,
  options: () => WindowGeometryOptions,
) {
  const rect = reactive({ x: 0, y: 24, width: 420, height: 820 })
  const maximized = ref(false)
  let restoreRect = { ...rect }
  let observer: ResizeObserver | undefined
  const { manipulating, start: startGesture, stop } = useWindowGesture()
  const mobile = () => options().mobileFullscreen && window.innerWidth <= 700
  const area = () => ({
    width: root.value?.parentElement?.clientWidth || window.innerWidth,
    height: root.value?.parentElement?.clientHeight || window.innerHeight,
  })

  function fit(contentWidth?: number) {
    if (!root.value || mobile() || document.fullscreenElement === root.value) return
    const bounds = area()
    const {
      aspectRatio,
      chrome = { width: 0, height: 48 },
      minSize = { width: 560, height: 400 },
    } = options()
    if (aspectRatio) {
      if (
        maximized.value ||
        contentWidth !== undefined ||
        rect.width > bounds.width - 16 ||
        rect.height > bounds.height - 16
      ) {
        const margin = maximized.value ? 24 : 16
        Object.assign(
          rect,
          aspectWindowSize({
            ratio: aspectRatio,
            contentWidth: maximized.value
              ? bounds.width - margin - chrome.width
              : (contentWidth ?? rect.width - chrome.width),
            chromeWidth: chrome.width,
            chromeHeight: chrome.height,
            maxOuterWidth: bounds.width - margin,
            maxOuterHeight: bounds.height - margin,
          }),
        )
      }
      if (maximized.value) {
        rect.x = (bounds.width - rect.width) / 2
        rect.y = 12
        return
      }
    } else if (maximized.value) {
      Object.assign(rect, { x: 0, y: 0, width: bounds.width, height: bounds.height })
      return
    } else {
      rect.width = Math.max(
        Math.min(minSize.width, bounds.width - 24),
        Math.min(rect.width, bounds.width - 12),
      )
      rect.height = Math.max(
        Math.min(minSize.height, bounds.height - 24),
        Math.min(rect.height, bounds.height - 12),
      )
    }
    constrainWindowPosition(rect, bounds, options().titlebarHeight ?? 48)
  }

  function start(event: PointerEvent, type: 'move' | 'resize') {
    if (
      event.button !== 0 ||
      mobile() ||
      maximized.value ||
      document.fullscreenElement === root.value
    )
      return
    if (
      type === 'move' &&
      (event.target as HTMLElement).closest(
        'button,a,input,textarea,select,[role=button],[role=combobox],[role=group]',
      )
    )
      return
    const initial = { ...rect }
    const { aspectRatio, chrome = { width: 0, height: 48 } } = options()
    startGesture(event, type, (dx, dy) => {
      if (type === 'move') {
        rect.x = initial.x + dx
        rect.y = initial.y + dy
        constrainWindowPosition(rect, area(), options().titlebarHeight ?? 48)
      } else if (aspectRatio) {
        const width = initial.width - chrome.width
        fit(contentWidthFromDrag(width, width / aspectRatio, aspectRatio, dx, dy))
      } else {
        rect.width = initial.width + dx
        rect.height = initial.height + dy
        fit()
      }
    })
  }

  function resizeKey(event: KeyboardEvent) {
    if (
      maximized.value ||
      mobile() ||
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    )
      return
    event.preventDefault()
    const { aspectRatio, chrome = { width: 0, height: 48 } } = options()
    if (aspectRatio) {
      fit(
        rect.width -
          chrome.width +
          (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) * (event.shiftKey ? 32 : 8),
      )
    } else {
      const step = event.shiftKey ? 40 : 10
      if (event.key === 'ArrowLeft') rect.width -= step
      if (event.key === 'ArrowRight') rect.width += step
      if (event.key === 'ArrowUp') rect.height -= step
      if (event.key === 'ArrowDown') rect.height += step
      fit()
    }
  }

  function toggleMaximize() {
    if (mobile() || document.fullscreenElement === root.value) return
    stop()
    if (maximized.value) {
      maximized.value = false
      Object.assign(rect, restoreRect)
    } else {
      restoreRect = { ...rect }
      maximized.value = true
    }
    fit()
  }

  watch(
    () => options().aspectRatio,
    () => fit(rect.width - (options().chrome?.width ?? 0)),
  )
  onMounted(() => {
    const bounds = area()
    const {
      aspectRatio,
      chrome = { width: 0, height: 48 },
      size = { width: 820, height: 650 },
      margin = 16,
    } = options()
    if (aspectRatio) {
      fit(Math.min(420, Math.max(180, (bounds.height - chrome.height - 48) * aspectRatio)))
      rect.x = Math.round((bounds.width - rect.width) / 2)
      rect.y = Math.round((bounds.height - rect.height) / 2)
      constrainWindowPosition(rect, bounds, options().titlebarHeight ?? 48)
    } else {
      rect.width = Math.min(size.width, bounds.width - margin * 2)
      rect.height = Math.min(size.height, bounds.height - margin * 2)
      rect.x = Math.max(12, Math.round((bounds.width - rect.width) / 2))
      rect.y = Math.max(12, Math.round((bounds.height - rect.height) / 2))
      fit()
    }
    observer = new ResizeObserver(() => fit())
    if (root.value?.parentElement) observer.observe(root.value.parentElement)
    window.addEventListener('resize', onResize)
  })
  const onResize = () => fit()
  onBeforeUnmount(() => {
    stop()
    observer?.disconnect()
    window.removeEventListener('resize', onResize)
  })
  return { rect, fit, start, stop, resizeKey, maximized, toggleMaximize, manipulating }
}
