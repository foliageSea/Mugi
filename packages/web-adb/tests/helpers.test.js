import assert from 'node:assert/strict'
import test from 'node:test'
import {
  abortable,
  fileName,
  isUnlocked,
  parseApps,
  serverCommand,
  shellQuote,
  storagePath,
  sha256Matches,
  SERVER_VERSION,
} from '../dist/helpers.js'

test('shell arguments, labels and unlock checks handle real device output', () => {
  assert.equal(shellQuote("a'; echo unsafe"), "'a'\"'\"'; echo unsafe'")
  for (const path of [
    '/sdcard',
    '/sdcard/',
    '/sdcard////',
    '/data/local/tmp',
    '/sdcard/../data',
    '/sdcard/a\n',
  ]) {
    assert.throws(() => storagePath(path))
  }
  assert.equal(storagePath('/sdcard/Download/报告.txt'), '/sdcard/Download/报告.txt')
  assert.throws(() => fileName('../test'))
  assert.deepEqual(
    parseApps(
      ' * 设置   com.android.settings\n - Very long application label\n    com.example.long\n',
      new Set(['com.example.long']),
    ),
    [
      { name: '设置', package: 'com.android.settings', system: true, launchable: false },
      {
        name: 'Very long application label',
        package: 'com.example.long',
        system: false,
        launchable: true,
      },
    ],
  )
  assert.equal(isUnlocked(' mWakefulness=Awake', ' mShowingLockscreen=false'), true)
  assert.equal(isUnlocked(' mWakefulness=Asleep', ''), false)
  assert.equal(isUnlocked(' mWakefulness=Awake', ' isKeyguardShowing=true'), false)
  const command = serverCommand(
    {
      mode: 'display',
      width: 900,
      height: 1600,
      dpi: 280,
      flex: true,
      audio: true,
    },
    '00000123',
  )
  assert.ok(command.includes(`${SERVER_VERSION} scid=00000123`))
  assert.ok(command.includes('new_display=900x1600/280'))
  assert.ok(command.includes('audio_codec=opus'))
  assert.equal(sha256Matches('a'.repeat(64), 'b'.repeat(64)), false)
  assert.equal(sha256Matches('sha256sum: not found', 'a'.repeat(64)), true)
})

test('scrcpy frame rate defaults to unlimited and is configurable in both cast modes', () => {
  for (const mode of ['mirror', 'display']) {
    const args = (options) =>
      serverCommand({ mode, ...options }, '00000123')
        .split(' ')
        .filter((arg) => arg.startsWith('max_fps='))
    assert.deepEqual(args({}), [])
    assert.deepEqual(args({ maxFps: 0 }), [])
    for (const maxFps of [1, 30, 120]) {
      assert.deepEqual(args({ maxFps }), [`max_fps=${maxFps}`])
    }
  }
})

test('scrcpy rejects frame rates that are not integers in the supported range', () => {
  for (const maxFps of [-1, 121, 29.5, NaN, Infinity, '30', null]) {
    assert.throws(() => serverCommand({ mode: 'mirror', maxFps }, '00000123'), RangeError)
  }
})

test('cancelled startup disposes resources that resolve after cancellation', async () => {
  const controller = new AbortController()
  let resolve
  const disposed = []
  const pending = abortable(
    new Promise((r) => {
      resolve = r
    }),
    controller.signal,
    (v) => disposed.push(v),
  )
  controller.abort()
  await assert.rejects(pending)
  resolve('late socket')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(disposed, ['late socket'])
})
