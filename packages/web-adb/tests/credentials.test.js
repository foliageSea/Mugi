import assert from 'node:assert/strict'
import test from 'node:test'
import { createCredentialStore, WebUsbConnection } from '../dist/index.js'

test('the package can be imported without browser globals', () => {
  assert.equal(WebUsbConnection.available(), false)
})

test('credential stores preserve existing keys and isolate application storage', async () => {
  const values = new Map([['old', JSON.stringify({ buffer: btoa('old-key') })]])
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  }
  const existing = createCredentialStore({ storage, storageKey: 'old', name: 'old-app' })
  assert.deepEqual(
    [...existing.iterateKeys()],
    [{ buffer: new TextEncoder().encode('old-key'), name: 'old-app' }],
  )
  const store = createCredentialStore({ storage, storageKey: 'new', name: 'new-app' })
  const generated = await store.generateKey()
  assert.equal(generated.name, 'new-app')
  assert.ok(generated.buffer.byteLength > 1000)
  const reloaded = createCredentialStore({ storage, storageKey: 'new', name: 'new-app' })
  assert.deepEqual([...reloaded.iterateKeys()], [generated])
  assert.equal(values.size, 2)
})

test('memory-only credentials survive unavailable storage', async () => {
  for (const storage of [
    null,
    {
      getItem() {
        throw new Error('denied')
      },
      setItem() {
        throw new Error('denied')
      },
    },
  ]) {
    const store = createCredentialStore({ storage })
    assert.deepEqual([...store.iterateKeys()], [])
    const key = await store.generateKey()
    assert.deepEqual([...store.iterateKeys()], [key])
  }
})
