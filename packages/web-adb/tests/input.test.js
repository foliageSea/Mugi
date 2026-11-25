import assert from 'node:assert/strict'
import test from 'node:test'
import { attachInput } from '../dist/scrcpy/input.js'

class FakeCanvas extends EventTarget {
  captured = new Set()

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 200 }
  }

  setPointerCapture(pointerId) {
    this.captured.add(pointerId)
  }

  hasPointerCapture(pointerId) {
    return this.captured.has(pointerId)
  }

  releasePointerCapture(pointerId) {
    this.captured.delete(pointerId)
    this.dispatchEvent(pointerEvent('lostpointercapture', pointerId, 0, 0))
  }
}

function pointerEvent(type, pointerId, clientX, clientY) {
  const event = new Event(type, { cancelable: true })
  for (const [name, value] of Object.entries({
    pointerId,
    pointerType: 'mouse',
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX,
    clientY,
  })) {
    Object.defineProperty(event, name, { value })
  }
  return event
}

test('releases a touch when mouseup arrives outside the mirror canvas', () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = new EventTarget()
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })

  try {
    const canvas = new FakeCanvas()
    const messages = []
    const detach = attachInput(
      canvas,
      (message) => messages.push(message),
      () => ({ width: 100, height: 200 }),
    )

    canvas.dispatchEvent(pointerEvent('pointerdown', 1, 20, 40))
    globalThis.window.dispatchEvent(pointerEvent('pointerup', 1, 140, 40))

    assert.deepEqual(
      messages.map((message) => message[1]),
      [0, 1],
    )
    assert.equal(canvas.hasPointerCapture(1), false)
    detach()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})
