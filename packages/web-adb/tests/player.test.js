import test from 'node:test'
import assert from 'node:assert/strict'
import { VideoPlayer } from '../dist/scrcpy/player.js'

function setup(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  t.mock.method(console, 'error', () => {})
  const decoders = []
  const requests = []
  const errors = []
  const drawn = []
  const previousDecoder = globalThis.VideoDecoder
  const previousChunk = globalThis.EncodedVideoChunk
  globalThis.VideoDecoder = class {
    constructor(hooks) {
      this.hooks = hooks
      this.state = 'unconfigured'
      this.decodeQueueSize = 0
      this.chunks = []
      decoders.push(this)
    }
    configure(config) {
      if (this.configureError) throw this.configureError
      this.config = config
      this.state = 'configured'
    }
    decode(chunk) {
      if (this.decodeError) throw this.decodeError
      this.chunks.push(chunk)
    }
    close() {
      this.state = 'closed'
    }
    fail() {
      this.close()
      this.hooks.error(new Error('hardware decoder failed'))
    }
  }
  globalThis.EncodedVideoChunk = class {
    constructor(options) {
      Object.assign(this, options)
    }
  }
  const canvas = { getContext: () => ({ drawImage: (frame) => drawn.push(frame) }) }
  const player = new VideoPlayer(canvas, {
    onRequestKeyFrame: () => requests.push(Date.now()),
    onError: (error) => errors.push(error),
  })
  t.after(() => {
    player.close()
    if (previousDecoder === undefined) delete globalThis.VideoDecoder
    else globalThis.VideoDecoder = previousDecoder
    if (previousChunk === undefined) delete globalThis.EncodedVideoChunk
    else globalThis.EncodedVideoChunk = previousChunk
  })
  player.configure('h264')
  const key = () => player.handlePacket(1n, false, true, Uint8Array.of(0x65))
  const delta = () => player.handlePacket(2n, false, false, Uint8Array.of(0x41))
  const advance = (seconds) => {
    for (let i = 0; i < seconds; i++) t.mock.timers.tick(1000)
  }
  return { player, decoders, requests, errors, drawn, key, delta, advance }
}

test('async decoder errors rebuild a closed decoder and retain codec config', (t) => {
  const { player, decoders, requests, errors, key, delta } = setup(t)
  player.handlePacket(0n, true, false, Uint8Array.of(0, 0, 1, 0x67))
  key()
  decoders[0].fail()
  assert.equal(decoders.length, 2)
  assert.equal(decoders[1].state, 'configured')
  assert.equal(player.dropping, true)
  assert.deepEqual(requests, [0])
  delta()
  assert.equal(decoders[1].chunks.length, 0)
  key()
  delta()
  assert.deepEqual([...decoders[1].chunks[0].data], [0, 0, 1, 0x67, 0x65])
  assert.equal(decoders[1].chunks.length, 2)
  assert.equal(errors.length, 0)
})

test('video counters track received payloads separately from drawn frames', (t) => {
  const { player, decoders, key, delta } = setup(t)
  const frame = { displayWidth: 720, displayHeight: 1280, close() {} }
  assert.deepEqual(player.getVideoCounters(), { frames: 0, bytes: 0 })
  player.handlePacket(0n, true, false, Uint8Array.of(0, 0, 1, 0x67))
  delta() // Dropped while waiting for the keyframe, but still received.
  key()
  assert.deepEqual(player.getVideoCounters(), { frames: 0, bytes: 6 })
  decoders[0].hooks.output(frame)
  player.configure('h264')
  decoders[0].hooks.output(frame) // Output from the retired decoder is ignored.
  key()
  decoders[1].hooks.output(frame)
  assert.deepEqual(player.getVideoCounters(), { frames: 2, bytes: 7 })
})

test('reset explicitly recreates an already closed decoder', (t) => {
  const { player, decoders, key } = setup(t)
  decoders[0].close()
  player.reset()
  assert.equal(decoders.length, 2)
  key()
  assert.equal(decoders[1].chunks.length, 1)
})

test('packets detect a closed decoder even without an error callback', (t) => {
  const { decoders, key } = setup(t)
  decoders[0].close()
  key()
  assert.equal(decoders.length, 2)
  assert.equal(decoders[1].chunks.length, 1)
})

test('new decoders reject delta frames until the first keyframe', (t) => {
  const { player, decoders, requests, key, delta, advance } = setup(t)
  delta()
  assert.equal(decoders[0].chunks.length, 0)
  assert.deepEqual(requests, [0])
  advance(1)
  assert.deepEqual(requests, [0, 1000])
  key()
  assert.equal(player.dropping, false)
  delta()
  assert.equal(decoders[0].chunks.length, 2)
})

test('backpressure requests recovery at most once per second and retries without packets', (t) => {
  const { player, decoders, requests, key, delta, advance } = setup(t)
  key()
  decoders[0].decodeQueueSize = 9
  delta()
  for (let i = 0; i < 100; i++) delta()
  assert.deepEqual(requests, [0])
  decoders[0].decodeQueueSize = 0
  delta()
  assert.equal(decoders[0].chunks.length, 1)
  advance(2)
  assert.deepEqual(requests, [0, 1000, 2000])
  key()
  assert.equal(player.dropping, false)
  advance(20)
  assert.equal(requests.length, 3)
  assert.equal(decoders.length, 1)
})

test('keyframe wait timeout rebuilds the decoder after five seconds', (t) => {
  const { player, decoders, key, delta, advance } = setup(t)
  key()
  advance(20) // The timeout starts with recovery, not initial configuration.
  player.handlePacket(0n, true, false, Uint8Array.of(0x67))
  decoders[0].decodeQueueSize = 9
  delta()
  advance(4)
  assert.equal(decoders.length, 1)
  advance(1)
  assert.equal(decoders.length, 2)
  assert.equal(decoders[0].state, 'closed')
  assert.equal(player.dropping, true)
  key()
  assert.deepEqual([...decoders[1].chunks[0].data], [0x67, 0x65])
  advance(20)
  assert.equal(decoders.length, 2)
})

test('unrecoverable keyframe wait reports one error and stops after fifteen seconds', (t) => {
  const { player, decoders, requests, errors, delta, advance } = setup(t)
  delta()
  advance(15)
  assert.equal(decoders.length, 3)
  assert.equal(requests.length, 15)
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /视频恢复超时/)
  assert.equal(player.closed, true)
  advance(20)
  player.reset()
  delta()
  assert.equal(errors.length, 1)
  assert.equal(requests.length, 15)
  assert.equal(decoders.length, 3)
})

test('synchronous decode failures rebuild and do not flood reset requests', (t) => {
  const { player, decoders, requests, errors, key, delta, advance } = setup(t)
  key()
  decoders[0].decodeError = new Error('bad chunk')
  delta()
  assert.equal(decoders.length, 2)
  decoders[1].decodeError = new Error('bad keyframe')
  key()
  assert.equal(decoders.length, 3)
  assert.equal(player.dropping, true)
  assert.deepEqual(requests, [0])
  advance(1)
  assert.deepEqual(requests, [0, 1000])
  key()
  assert.equal(errors.length, 0)
})

test('decoder reconfiguration failures are reported instead of swallowed', (t) => {
  const { player, errors, delta } = setup(t)
  t.mock.method(globalThis.VideoDecoder.prototype, 'configure', () => {
    throw new Error('decoder unavailable')
  })
  player.reset()
  assert.equal(errors.length, 1)
  assert.equal(errors[0].message, 'decoder unavailable')
  assert.equal(player.closed, true)
  delta()
  assert.equal(errors.length, 1)
})

test('reconfigure clears stale codec config and cancels previous recovery', (t) => {
  const { player, decoders, requests, errors, key, delta, advance } = setup(t)
  player.handlePacket(0n, true, false, Uint8Array.of(0x67))
  delta()
  player.configure('h264')
  advance(20)
  assert.equal(requests.length, 1)
  assert.equal(errors.length, 0)
  key()
  assert.deepEqual([...decoders[1].chunks[0].data], [0x65])
})

test('late callbacks from retired decoders cannot draw or restart recovery', (t) => {
  const { player, decoders, requests, drawn } = setup(t)
  player.configure('h264')
  let closedFrames = 0
  decoders[0].hooks.output({ close: () => closedFrames++ })
  decoders[0].fail()
  assert.equal(closedFrames, 1)
  assert.equal(drawn.length, 0)
  assert.equal(decoders.length, 2)
  assert.equal(requests.length, 0)
})

test('closing cancels retries and ignores late errors, frames, and resets', (t) => {
  const { player, decoders, requests, errors, drawn, delta, advance } = setup(t)
  delta()
  player.close()
  advance(20)
  player.reset()
  player.configure('h264')
  decoders[0].fail()
  let closedFrames = 0
  decoders[0].hooks.output({ close: () => closedFrames++ })
  assert.equal(closedFrames, 1)
  assert.equal(drawn.length, 0)
  assert.equal(decoders.length, 1)
  assert.equal(requests.length, 1)
  assert.equal(errors.length, 0)
})
