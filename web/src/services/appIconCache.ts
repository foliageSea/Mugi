const DATABASE = 'mugi.app-icons'
const STORE = 'icons'
const MAX_ENTRIES = 1024
const MAX_ICON_BYTES = 256 << 10

interface CachedIcon {
  revision: string
  icon: Blob
  storedAt: number
}

let database: Promise<IDBDatabase> | undefined

function open() {
  if (database) return database
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    let blocked = false
    request.onblocked = () => {
      blocked = true
      reject(new Error('App icon cache is blocked'))
    }
    request.onerror = () => reject(request.error)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE).createIndex('storedAt', 'storedAt')
    }
    request.onsuccess = () => {
      const db = request.result
      if (blocked) {
        db.close()
        return
      }
      const close = () => {
        db.close()
        if (database === pending) database = undefined
      }
      db.onversionchange = close
      db.onclose = close
      resolve(db)
    }
  })
  database = pending
  void pending.catch(() => {
    if (database === pending) database = undefined
  })
  return pending
}

export async function readCachedAppIcon(device: string, pkg: string, revision: string) {
  try {
    const db = await open()
    return await new Promise<Blob | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const request = tx.objectStore(STORE).get([device, pkg])
      request.onsuccess = () => {
        const stored = request.result as CachedIcon | undefined
        const icon = stored?.revision === revision ? stored?.icon : undefined
        resolve(
          icon instanceof Blob && icon.type === 'image/png' && icon.size <= MAX_ICON_BYTES
            ? icon
            : undefined,
        )
      }
      tx.onabort = () => reject(tx.error)
    })
  } catch {
    // Privacy settings, quota/eviction or storage faults must not block device access.
    return undefined
  }
}

export async function writeCachedAppIcon(
  device: string,
  pkg: string,
  revision: string,
  icon: Blob,
) {
  if (icon.type !== 'image/png' || !icon.size || icon.size > MAX_ICON_BYTES) return
  try {
    const db = await open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
      const store = tx.objectStore(STORE)
      // Replace older revisions for this device/package, rather than accumulating versions.
      store.put({ revision, icon, storedAt: Date.now() } satisfies CachedIcon, [device, pkg])
      const count = store.count()
      count.onsuccess = () => {
        let excess = count.result - MAX_ENTRIES
        if (excess <= 0) return
        const cursor = store.index('storedAt').openCursor()
        cursor.onsuccess = () => {
          if (!cursor.result) return
          cursor.result.delete()
          if (--excess > 0) cursor.result.continue()
        }
      }
    })
  } catch {
    /* Persistence is optional; this icon can still be displayed. */
  }
}
