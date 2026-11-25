// DOM events -> scrcpy control messages.
import { ControlEncoder, Action, Button, POINTER_FINGER, POINTER_MOUSE } from './protocol.js'
import { androidKeycode, metastateOf, KEYCODE } from './keymap.js'

// requestAnimationFrame may not exist in non-browser test environments.
const raf =
  typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : (fn) => setTimeout(fn, 16)
const cancelRaf =
  typeof globalThis.cancelAnimationFrame === 'function'
    ? globalThis.cancelAnimationFrame.bind(globalThis)
    : clearTimeout

// Attaches touch/mouse/wheel/keyboard handling to a window's canvas.
// getSize() must return the current video frame size {width, height}.
export function attachInput(canvas, send, getSize) {
  const listeners = new AbortController()
  const listen = (type, handler, options = {}) => {
    canvas.addEventListener(type, handler, { ...options, signal: listeners.signal })
  }
  const listenWindow = (type, handler, options = {}) => {
    window.addEventListener(type, handler, { ...options, signal: listeners.signal })
  }
  const listenDocument = (type, handler, options = {}) => {
    document.addEventListener(type, handler, { ...options, signal: listeners.signal })
  }
  let activePointer = null
  // High-refresh mice and pens fire pointermove far faster than the device
  // can consume touches. Coalesce to one move per animation frame, always
  // keeping the freshest coordinates; down/up/scroll flush first to preserve
  // event order.
  let pendingMove = null
  let moveFrame = 0
  const flushMove = () => {
    if (moveFrame) {
      cancelRaf(moveFrame)
      moveFrame = 0
    }
    if (!pendingMove || !activePointer) {
      pendingMove = null
      return
    }
    const { x, y, width, height, buttons } = pendingMove
    pendingMove = null
    send(
      ControlEncoder.touch(
        2 /* AMOTION_EVENT_ACTION_MOVE */,
        activePointer.pointerId,
        x,
        y,
        width,
        height,
        1.0,
        0,
        buttons,
      ),
    )
  }

  const actionButton = (event) => {
    if (event.pointerType !== 'mouse') return 0
    if (event.button === 2) return Button.secondary
    if (event.button === 1) return Button.tertiary
    return Button.primary
  }

  const toDeviceCoords = (e) => {
    const rect = canvas.getBoundingClientRect()
    const { width, height } = getSize()
    if (!width || !height || rect.width === 0) return null
    const x = Math.round(((e.clientX - rect.left) / rect.width) * width)
    const y = Math.round(((e.clientY - rect.top) / rect.height) * height)
    return {
      x: Math.max(0, Math.min(width, x)),
      y: Math.max(0, Math.min(height, y)),
      width,
      height,
    }
  }

  listen('pointerdown', (e) => {
    // A desktop right click is the Android Back action rather than a secondary
    // touch. Handle it before creating a pointer so no touch-down is sent.
    if (e.pointerType === 'mouse' && e.button === 2) {
      navBack(send)
      e.preventDefault()
      return
    }
    if (activePointer !== null) return
    const p = toDeviceCoords(e)
    if (!p) return
    activePointer = {
      id: e.pointerId,
      pointerId: e.pointerType === 'mouse' ? POINTER_MOUSE : POINTER_FINGER,
      actionButton: actionButton(e),
      position: p,
    }
    canvas.setPointerCapture(e.pointerId)
    send(
      ControlEncoder.touch(
        Action.down,
        activePointer.pointerId,
        p.x,
        p.y,
        p.width,
        p.height,
        1.0,
        activePointer.actionButton,
        e.pointerType === 'mouse' ? e.buttons : 0,
      ),
    )
    e.preventDefault()
  })

  listen('pointermove', (e) => {
    if (activePointer?.id !== e.pointerId) return
    const p = toDeviceCoords(e)
    if (!p) return
    activePointer.position = p
    pendingMove = { ...p, buttons: e.pointerType === 'mouse' ? e.buttons : 0 }
    if (!moveFrame) moveFrame = raf(flushMove)
    e.preventDefault()
  })

  const release = (e) => {
    if (e && activePointer?.id !== e.pointerId) return
    if (!activePointer) return
    flushMove()
    const pointer = activePointer
    activePointer = null
    const p = (e && toDeviceCoords(e)) || pointer.position
    if (canvas.hasPointerCapture?.(pointer.id)) canvas.releasePointerCapture(pointer.id)
    if (!p) return
    send(
      ControlEncoder.touch(
        Action.up,
        pointer.pointerId,
        p.x,
        p.y,
        p.width,
        p.height,
        0.0,
        pointer.actionButton,
        0,
      ),
    )
    if (e?.cancelable) e.preventDefault()
  }
  listen('pointerup', release)
  listen('pointercancel', release)
  listen('lostpointercapture', release)
  // Pointer capture can be lost when the pointer leaves the browser window,
  // so keep a global release path for a mouse-up outside the mirror canvas.
  listenWindow('pointerup', release)
  listenWindow('pointercancel', release)
  listenWindow('blur', () => release())
  listenWindow('pagehide', () => release())
  listenDocument('visibilitychange', () => {
    if (document.visibilityState === 'hidden') release()
  })

  listen(
    'wheel',
    (e) => {
      const p = toDeviceCoords(e)
      if (!p) return
      flushMove()
      // DOM deltaY is positive downward; Android AXIS_VSCROLL is positive upward.
      const v = Math.max(-4, Math.min(4, -e.deltaY / 100))
      const h = Math.max(-4, Math.min(4, e.deltaX / 100))
      send(ControlEncoder.scroll(p.x, p.y, p.width, p.height, h, v, 0))
      e.preventDefault()
    },
    { passive: false },
  )

  listen('contextmenu', (e) => e.preventDefault())

  // --- keyboard ---
  let composing = false
  const textKeys = new Set()
  listen('compositionstart', () => {
    composing = true
  })
  listen('compositionend', (e) => {
    composing = false
    if (e.data) send(ControlEncoder.text(e.data))
  })

  listen('keydown', (e) => {
    if (composing || e.isComposing) {
      e.preventDefault()
      return
    }
    // Printable characters go through INJECT_TEXT (layout independent).
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      textKeys.add(e.code)
      send(ControlEncoder.text(e.key))
      e.preventDefault()
      return
    }
    const kc = androidKeycode(e.code)
    if (kc) {
      send(ControlEncoder.keycode(Action.down, kc, e.repeat ? 1 : 0, metastateOf(e)))
      e.preventDefault()
    }
  })

  listen('keyup', (e) => {
    if (textKeys.delete(e.code)) {
      e.preventDefault()
      return
    }
    const kc = androidKeycode(e.code)
    if (kc) {
      send(ControlEncoder.keycode(Action.up, kc, 0, metastateOf(e)))
      e.preventDefault()
    }
  })

  // --- clipboard ---
  listen('paste', (e) => {
    const text = e.clipboardData ? e.clipboardData.getData('text') : ''
    if (text) send(ControlEncoder.setClipboard(nextSeq(), true, text))
    e.preventDefault()
  })
  const copyOut = () => {
    setTimeout(async () => {
      try {
        const text = await navigator.clipboard.readText()
        if (text) send(ControlEncoder.setClipboard(nextSeq(), false, text))
      } catch (err) {
        /* clipboard read needs permission */
      }
    }, 50)
  }
  listen('copy', copyOut)
  listen('cut', copyOut)
  return () => {
    if (moveFrame) cancelRaf(moveFrame)
    pendingMove = null
    listeners.abort()
  }
}

let seq = 1n
function nextSeq() {
  return seq++
}

// Navigation helpers used by window toolbars.
export function navBack(send) {
  send(ControlEncoder.keycode(Action.down, KEYCODE.BACK, 0, 0))
  send(ControlEncoder.keycode(Action.up, KEYCODE.BACK, 0, 0))
}
export function navHome(send) {
  send(ControlEncoder.keycode(Action.down, KEYCODE.HOME, 0, 0))
  send(ControlEncoder.keycode(Action.up, KEYCODE.HOME, 0, 0))
}
export function navRecents(send) {
  send(ControlEncoder.keycode(Action.down, KEYCODE.APP_SWITCH, 0, 0))
  send(ControlEncoder.keycode(Action.up, KEYCODE.APP_SWITCH, 0, 0))
}
