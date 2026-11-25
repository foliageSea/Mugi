import { onBeforeUnmount, ref } from 'vue'

export function constrainWindowPosition(
  rect: { x: number; y: number; width: number },
  area: { width: number; height: number },
  titlebarHeight: number,
) {
  // Let large windows travel as freely as small ones, retaining a usable grab area.
  const visibleWidth = Math.min(120, rect.width, area.width)
  rect.x = Math.max(visibleWidth - rect.width, Math.min(rect.x, area.width - visibleWidth))
  rect.y = Math.max(0, Math.min(rect.y, area.height - titlebarHeight))
}

// Share pointer capture and frame scheduling across desktop windows.
export function useWindowGesture() {
  const manipulating = ref(false)
  let pointerId: number | undefined
  let target: HTMLElement | undefined
  let frame = 0
  let pending: { x: number; y: number } | undefined
  let origin = { x: 0, y: 0 }
  let update: ((dx: number, dy: number) => void) | undefined

  function flush() {
    cancelAnimationFrame(frame)
    frame = 0
    if (!pending) return
    update?.(pending.x - origin.x, pending.y - origin.y)
    pending = undefined
  }

  function move(event: PointerEvent) {
    if (event.pointerId !== pointerId) return
    pending = { x: event.clientX, y: event.clientY }
    if (!frame) frame = requestAnimationFrame(flush)
  }

  function stop() {
    if (pointerId === undefined) return
    flush()
    const id = pointerId
    pointerId = undefined
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('blur', stop)
    target?.removeEventListener('lostpointercapture', cancel)
    if (target?.hasPointerCapture(id)) target.releasePointerCapture(id)
    target = undefined
    update = undefined
    manipulating.value = false
    delete document.body.dataset.windowGesture
  }

  function finish(event: PointerEvent) {
    if (event.pointerId !== pointerId) return
    // Commit the release position even when the next animation frame hasn't run.
    move(event)
    stop()
  }

  function cancel(event: PointerEvent) {
    if (event.pointerId === pointerId) stop()
  }

  function start(
    event: PointerEvent,
    type: 'move' | 'resize',
    onUpdate: (dx: number, dy: number) => void,
  ) {
    if (event.button !== 0 || !event.isPrimary || pointerId !== undefined) return
    target = event.currentTarget as HTMLElement
    pointerId = event.pointerId
    origin = { x: event.clientX, y: event.clientY }
    update = onUpdate
    target.setPointerCapture(pointerId)
    target.addEventListener('lostpointercapture', cancel)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', stop)
    manipulating.value = true
    document.body.dataset.windowGesture = type
    event.preventDefault()
  }

  onBeforeUnmount(stop)
  return { manipulating, start, stop }
}
