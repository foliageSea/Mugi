import { onBeforeUnmount, onMounted, type Ref } from 'vue'

export function useDockMagnification(dock: Ref<HTMLElement | undefined>) {
  let pointerX: number | undefined
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
      const left = track!.getBoundingClientRect().left - track!.scrollLeft
      // Use layout coordinates so animated transforms never feed back into the distance.
      const sizes = items.map((item) => {
        if (!item.classList.contains('dock-item')) return { scale: 1, extra: 0 }
        const width = item.offsetWidth
        const distance = Math.abs((pointerX ?? Infinity) - (left + item.offsetLeft + width / 2))
        const influence = distance < 140 ? (1 + Math.cos((distance / 140) * Math.PI)) / 2 : 0
        return { scale: 1 + influence * 0.5, extra: width * influence * 0.5 }
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
      pointerX = undefined
      root!.removeAttribute('data-magnifying')
      schedule()
    }

    function move(event: PointerEvent) {
      if (event.pointerType === 'touch' || !motion.matches || !hover.matches) return
      pointerX = event.clientX
      root!.setAttribute('data-magnifying', 'true')
      schedule()
    }

    const resize = new ResizeObserver(reset)
    resize.observe(track)
    const children = new MutationObserver(schedule)
    children.observe(track, { childList: true })
    root.addEventListener('pointermove', move)
    root.addEventListener('pointerleave', reset)
    root.addEventListener('pointercancel', reset)
    track.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('blur', reset)
    motion.addEventListener('change', reset)
    hover.addEventListener('change', reset)
    cleanup = () => {
      resize.disconnect()
      children.disconnect()
      root.removeEventListener('pointermove', move)
      root.removeEventListener('pointerleave', reset)
      root.removeEventListener('pointercancel', reset)
      track.removeEventListener('scroll', schedule)
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
