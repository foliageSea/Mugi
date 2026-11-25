import assert from 'node:assert/strict'
import test from 'node:test'
import { openTerminal, openLogcat } from '../dist/index.js'

function fixture() {
  const encoder = new TextEncoder()
  const cleanups = new Set()
  const output = []
  const sizes = []
  let killed = 0
  let resolveExit
  let stdout, stderr
  const process = {
    exited: new Promise((r) => {
      resolveExit = r
    }),
    stdout: new ReadableStream({
      start(c) {
        stdout = c
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        stderr = c
      },
    }),
    input: new WritableStream({
      write(bytes) {
        output.push(new TextDecoder().decode(bytes))
      },
    }),
    resize: async (rows, cols) => {
      sizes.push([rows, cols])
    },
    kill: async () => {
      if (killed) return
      killed++
      stdout.close()
      stderr.close()
      resolveExit(0)
    },
  }
  process.output = process.stdout
  const usb = {
    adb: {
      subprocess: { shellProtocol: { pty: async () => process, spawn: async () => process } },
    },
    registerSessionCleanup: (cleanup) => {
      cleanups.add(cleanup)
      return () => cleanups.delete(cleanup)
    },
  }
  return {
    usb,
    cleanups,
    output,
    sizes,
    killed: () => killed,
    push: (value) => stdout.enqueue(encoder.encode(value)),
  }
}

test('terminal supports input and resize and joins connection cleanup', async () => {
  const f = fixture()
  const output = []
  const terminal = await openTerminal(
    f.usb,
    24,
    80,
    new AbortController().signal,
    async (bytes) => {
      output.push(new TextDecoder().decode(bytes))
    },
    () => {},
  )
  f.push('hello')
  await terminal.write('pwd\n')
  await terminal.resize(30, 100)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(output, ['hello'])
  assert.deepEqual(f.output, ['pwd\n'])
  assert.deepEqual(f.sizes, [
    [24, 80],
    [30, 100],
  ])
  await Promise.all([...f.cleanups].map((cleanup) => cleanup()))
  terminal.close()
  assert.equal(f.killed(), 1)
  assert.equal(f.cleanups.size, 0)
})

test('logcat streams bytes and abort closes the process exactly once', async () => {
  const f = fixture()
  const controller = new AbortController()
  const chunks = []
  const ended = []
  const logcat = await openLogcat(
    f.usb,
    controller.signal,
    (bytes) => chunks.push(new TextDecoder().decode(bytes)),
    (reason) => ended.push(reason),
  )
  f.push('USB log\n')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(chunks, ['USB log\n'])
  controller.abort()
  logcat.close()
  await new Promise((r) => setImmediate(r))
  assert.equal(f.killed(), 1)
  assert.equal(f.cleanups.size, 0)
  assert.deepEqual(ended, [])
})

test('already-aborted streams do not spawn a process', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    openLogcat(
      {},
      controller.signal,
      () => {},
      () => {},
    ),
    { name: 'AbortError' },
  )
  await assert.rejects(
    openTerminal(
      {},
      24,
      80,
      controller.signal,
      async () => {},
      () => {},
    ),
    { name: 'AbortError' },
  )
})
