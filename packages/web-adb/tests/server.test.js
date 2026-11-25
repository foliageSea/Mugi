import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchServerBinary, fetchServerDigest } from '../dist/server.js'
import { sha256Hex } from '../dist/helpers.js'

test('custom server loaders are cached independently and return matching digests', async () => {
  let calls = 0
  const bytes = new Uint8Array([0x50, 0x4b, 1, 2])
  const source = async () => {
    calls++
    return bytes
  }
  const other = async () => new Uint8Array([0x50, 0x4b, 3])
  const [first, second] = await Promise.all([fetchServerBinary(source), fetchServerBinary(source)])
  assert.equal(first, second)
  assert.equal(calls, 1)
  assert.equal(await fetchServerDigest(source), await sha256Hex(bytes))
  assert.notDeepEqual(await fetchServerBinary(other), first)
})

test('invalid server resources are not cached and can be retried', async () => {
  let calls = 0
  const source = async () =>
    ++calls === 1
      ? new TextEncoder().encode('<html>not a server</html>')
      : new Uint8Array([0x50, 0x4b])
  await assert.rejects(fetchServerBinary(source), /静态资源无效/)
  assert.deepEqual(await fetchServerBinary(source), new Uint8Array([0x50, 0x4b]))
  assert.equal(calls, 2)
})
