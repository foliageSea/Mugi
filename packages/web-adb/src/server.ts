import { sha256Hex } from './helpers.js'

/** A custom loader must return the bundled scrcpy version (4.1). */
export type ServerSource = () => Promise<Uint8Array>

let binary: Promise<Uint8Array> | undefined
const customBinaries = new WeakMap<ServerSource, Promise<Uint8Array>>()
const digests = new WeakMap<Uint8Array, Promise<string>>()

export function fetchServerBinary(source?: ServerSource): Promise<Uint8Array> {
  const cached = source ? customBinaries.get(source) : binary
  if (cached) return cached
  const pending = Promise.resolve()
    .then(async () => {
      if (source) return source()
      const response = await fetch(new URL('./assets/scrcpy-server.bin', import.meta.url))
      if (!response.ok) throw new Error(`读取 scrcpy-server 失败（${response.status}）`)
      return new Uint8Array(await response.arrayBuffer())
    })
    .then((bytes) => {
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('scrcpy-server 静态资源无效')
      return bytes
    })
    .catch((error) => {
      if (source) customBinaries.delete(source)
      else binary = undefined
      throw error
    })
  if (source) customBinaries.set(source, pending)
  else binary = pending
  return pending
}

export async function fetchServerDigest(source?: ServerSource) {
  const bytes = await fetchServerBinary(source)
  let digest = digests.get(bytes)
  if (!digest) {
    digest = sha256Hex(bytes)
    digests.set(bytes, digest)
  }
  return digest
}
