import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

export function useDockMagnification(
  dock: Ref<HTMLElement | undefined>,
  vertical: Readonly<Ref<boolean>>,
) {
  let pointer: number | undefined
  let frame = 0
  let cleanup: (() => void) | undefined

  onMounted(() => {
    const root = dock.value
    const track = root?.querySelector<HTMLElement>('.dock-track')
    if (!root || !track) return

    const motion = window.matchMedia('(prefers-reduced-motion: no-preference)')
    const hover = window.matchMedia('(any-hover: hover) and (any-pointer: fine)')

    function render() {
      frame = 0
      const items = Array.from(
        track!.querySelectorAll<HTMLElement>('.dock-item, [data-slot="separator"]'),
      )
      const rect = track!.getBoundingClientRect()
      const alongY = vertical.value
      const start = alongY ? rect.top - track!.scrollTop : rect.left - track!.scrollLeft
      // Use layout coordinates so animated transforms never feed back into the distance.
      const sizes = items.map((item) => {
        if (!item.classList.contains('dock-item')) return { scale: 1, extra: 0 }
        const size = alongY ? item.offsetHeight : item.offsetWidth
        const offset = alongY ? item.offsetTop : item.offsetLeft
        const distance = Math.abs((pointer ?? Infinity) - (start + offset + size / 2))
        const influence = distance < 140 ? (1 + Math.cos((distance / 140) * Math.PI)) / 2 : 0
        return { scale: 1 + influence * 0.5, extra: size * influence * 0.5 }
      })
      const expansion = sizes.reduce((total, item) => total + item.extra, 0)
      root!.style.setProperty('--dock-expansion', `${expansion}px`)
      let shift = -expansion / 2
      items.forEach((item, index) => {
        const { scale, extra } = sizes[index]!
        item.style.setProperty('--dock-scale', String(scale))
        item.style.setProperty('--dock-shift', `${shift + extra / 2}px`)
        shift += extra
      })
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(render)
    }

    function reset() {
      pointer = undefined
      root!.removeAttribute('data-magnifying')
      schedule()
    }

    function move(event: PointerEvent) {
      if (
        event.pointerType === 'touch' ||
        !motion.matches ||
        !hover.matches ||
        root!.hasAttribute('data-scrollable')
      )
        return
      pointer = vertical.value ? event.clientY : event.clientX
      root!.setAttribute('data-magnifying', 'true')
      schedule()
    }

    function scrollBottomDock(event: WheelEvent) {
      if (
        vertical.value ||
        !root!.hasAttribute('data-scrollable') ||
        event.ctrlKey ||
        event.shiftKey ||
        event.deltaX ||
        !event.deltaY
      )
        return
      const before = track!.scrollLeft
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? track!.clientWidth : 1
      track!.scrollLeft += event.deltaY * unit
      if (track!.scrollLeft !== before) event.preventDefault()
    }

    function updateOverflow() {
      const last = track!.querySelector<HTMLElement>('.dock-item:last-child')
      if (!last) return
      const style = getComputedStyle(track!)
      // Layout offsets exclude hover transforms, which can extend beyond a fitted track.
      const scrollable = vertical.value
        ? last.offsetTop + last.offsetHeight + parseFloat(style.paddingBottom) >
          track!.clientHeight + 1
        : last.offsetLeft + last.offsetWidth + parseFloat(style.paddingRight) >
          track!.clientWidth + 1
      root!.toggleAttribute('data-scrollable', scrollable)
    }

    function updateFit() {
      const icons = track!.querySelectorAll(':scope > .dock-item').length
      const separators = track!.querySelectorAll(':scope > [data-slot="separator"]').length
      track!.style.setProperty('--dock-icon-count', String(Math.max(1, icons)))
      track!.style.setProperty('--dock-gap-count', String(Math.max(0, icons + separators - 1)))
      track!.style.setProperty('--dock-separator-count', String(separators))
      updateOverflow()
      reset()
    }

    const stopWatching = watch(
      vertical,
      () => {
        track.scrollTo(0, 0)
        updateOverflow()
        reset()
      },
      { flush: 'post' },
    )
    const resize = new ResizeObserver(() => {
      updateOverflow()
      reset()
    })
    resize.observe(track)
    const children = new MutationObserver(updateFit)
    children.observe(track, { childList: true })
    updateFit()
    root.addEventListener('pointermove', move)
    root.addEventListener('pointerleave', reset)
    root.addEventListener('pointercancel', reset)
    track.addEventListener('scroll', schedule, { passive: true })
    track.addEventListener('wheel', scrollBottomDock, { passive: false })
    window.addEventListener('blur', reset)
    motion.addEventListener('change', reset)
    hover.addEventListener('change', reset)
    cleanup = () => {
      stopWatching()
      resize.disconnect()
      children.disconnect()
      root.removeEventListener('pointermove', move)
      root.removeEventListener('pointerleave', reset)
      root.removeEventListener('pointercancel', reset)
      track.removeEventListener('scroll', schedule)
      track.removeEventListener('wheel', scrollBottomDock)
      window.removeEventListener('blur', reset)
      motion.removeEventListener('change', reset)
      hover.removeEventListener('change', reset)
    }
  })

  onBeforeUnmount(() => {
    cleanup?.()
    cancelAnimationFrame(frame)
  })
}
