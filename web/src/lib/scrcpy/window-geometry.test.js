import test from 'node:test'
import assert from 'node:assert/strict'
import { aspectWindowSize, contentWidthFromDrag, displaySizeForDevice } from './window-geometry.js'

test('virtual display uses the physical device aspect ratio', () => {
  assert.deepEqual(displaySizeForDevice(1080, 2400), { width: 720, height: 1600 })
  assert.deepEqual(displaySizeForDevice(1440, 3120), { width: 738, height: 1600 })
  assert.deepEqual(displaySizeForDevice(undefined, undefined), { width: 900, height: 1600 })
})

test('window size preserves the video aspect ratio below the chrome', () => {
  const size = aspectWindowSize({
    ratio: 1080 / 2400,
    contentWidth: 360,
    chromeWidth: 2,
    chromeHeight: 86,
    maxOuterWidth: 1000,
    maxOuterHeight: 1000,
  })
  assert.deepEqual(size, { width: 362, height: 886 })
})

test('window size is constrained by available height without changing ratio', () => {
  const size = aspectWindowSize({
    ratio: 16 / 9,
    contentWidth: 900,
    chromeWidth: 2,
    chromeHeight: 86,
    maxOuterWidth: 1000,
    maxOuterHeight: 500,
  })
  assert.deepEqual(size, { width: 738, height: 500 })
})

test('resize follows the dominant pointer axis', () => {
  assert.equal(contentWidthFromDrag(360, 800, 0.45, 40, 10), 400)
  assert.equal(contentWidthFromDrag(360, 800, 0.45, 5, 100), 405)
})
