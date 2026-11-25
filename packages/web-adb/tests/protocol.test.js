import test from 'node:test'
import assert from 'node:assert/strict'
import { ControlEncoder, DeviceMsgParser, StreamParser } from '../dist/scrcpy/protocol.js'

function be32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

test('video stream parser handles fragmented handshake and packets', () => {
  const events = []
  const parser = new StreamParser(true, (event) => events.push(event))
  const name = new Uint8Array(64)
  name.set(new TextEncoder().encode('Pixel Demo'))
  const session = Uint8Array.from([0x80, 0, 0, 0, ...be32(1080), ...be32(2400)])
  const payload = Uint8Array.from([0, 0, 0, 1, 0x65, 1, 2])
  const media = new Uint8Array(12 + payload.length)
  const view = new DataView(media.buffer)
  view.setBigUint64(0, (1n << 61n) | 12345n)
  view.setUint32(8, payload.length)
  media.set(payload, 12)
  const all = Uint8Array.from([
    0,
    ...name,
    ...new TextEncoder().encode('h264'),
    ...session,
    ...media,
  ])

  parser.push(all.subarray(0, 17))
  parser.push(all.subarray(17, 73))
  parser.push(all.subarray(73))

  assert.equal(events[0].name, 'Pixel Demo')
  assert.equal(events[1].codec, 'h264')
  assert.deepEqual(events[2], { type: 'session', width: 1080, height: 2400, resized: false })
  assert.equal(events[3].key, true)
  assert.equal(events[3].pts, 12345n)
  assert.deepEqual([...events[3].payload], [...payload])
})

test('audio codec ids discard leading NUL bytes', () => {
  const events = []
  const parser = new StreamParser(false, (event) => events.push(event))
  parser.push(Uint8Array.from([0, 0x61, 0x61, 0x63]))
  assert.equal(events[0].codec, 'aac')
})

test('control messages match scrcpy golden vectors', () => {
  assert.deepEqual(
    [...ControlEncoder.keycode(1, 0x42, 5, 0x41)],
    [0, 1, 0, 0, 0, 0x42, 0, 0, 0, 5, 0, 0, 0, 0x41],
  )
  assert.deepEqual([...ControlEncoder.resizeDisplay(1920, 1080)], [21, 7, 128, 4, 56])
  assert.deepEqual([...ControlEncoder.setDisplayPower(false)], [10, 0])
  assert.deepEqual([...ControlEncoder.setDisplayPower(true)], [10, 1])
  assert.deepEqual([...ControlEncoder.backOrScreenOn(0)], [4, 0])
  const scroll = ControlEncoder.scroll(260, 1026, 1080, 1920, 16, -16, 1)
  assert.deepEqual([...scroll.slice(13, 17)], [0x7f, 0xff, 0x80, 0x00])
})

test('device clipboard parser waits for a complete message', () => {
  const messages = []
  const parser = new DeviceMsgParser((message) => messages.push(message))
  const text = new TextEncoder().encode('ABC')
  parser.push(Uint8Array.from([0, 0, 0]))
  assert.equal(messages.length, 0)
  parser.push(Uint8Array.from([0, 3, ...text]))
  assert.deepEqual(messages, [{ type: 'clipboard', text: 'ABC' }])
})

test('app restart requests a cold start without changing normal launches', () => {
  const name = 'com.xiaomi.smarthome'
  const normal = ControlEncoder.startApp(name)
  const restart = ControlEncoder.restartApp(name)
  assert.equal(restart[0], 16)
  assert.equal(restart[1], name.length + 1)
  assert.equal(new TextDecoder().decode(restart.subarray(2)), '+' + name)
  assert.equal(new TextDecoder().decode(normal.subarray(2)), name)
  assert.equal(ControlEncoder.restartApp('a'.repeat(254))[1], 255)
  assert.throws(() => ControlEncoder.restartApp('a'.repeat(255)), RangeError)
})
