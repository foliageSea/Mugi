export interface Credential {
  buffer: Uint8Array
  name: string
}

export interface CredentialStore {
  generateKey(): Promise<Credential>
  iterateKeys(): Iterable<Credential> | AsyncIterable<Credential>
}

export interface CredentialStoreOptions {
  storageKey?: string
  name?: string
  /** null disables persistence; otherwise localStorage is used by default. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  const key = options.storageKey ?? 'mugi.webusb.adb-key.v1'
  const name = options.name ?? 'mugi-webusb'
  let memoryKey: Credential | undefined
  const storage = () => (options.storage === undefined ? globalThis.localStorage : options.storage)
  return {
    async generateKey() {
      const pair = await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-1',
        },
        true,
        ['sign', 'verify'],
      )
      const buffer = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
      memoryKey = { buffer, name }
      try {
        storage()?.setItem(key, btoa(String.fromCharCode(...buffer)))
      } catch {
        // Private browsing may only allow an in-memory key.
      }
      return memoryKey
    },
    *iterateKeys() {
      if (memoryKey) {
        yield memoryKey
        return
      }
      try {
        const raw = storage()?.getItem(key)
        if (!raw) return
        // Accept both JSON-wrapped and plain base64 credentials.
        const encoded = raw.startsWith('{') ? JSON.parse(raw).buffer : raw
        memoryKey = { buffer: Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)), name }
        yield memoryKey
      } catch {
        // Ignore damaged or unavailable saved keys.
      }
    },
  }
}
