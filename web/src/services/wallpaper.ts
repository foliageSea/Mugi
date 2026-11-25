const DATABASE = 'mugi-desktop'
const DATABASE_VERSION = 1
const STORE = 'wallpaper'
const WALLPAPER_KEY = 'desktop'

function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('无法打开浏览器壁纸缓存'))
  })
}

export async function readWallpaper() {
  const db = await database()
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(WALLPAPER_KEY)
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null)
      request.onerror = () => reject(request.error || new Error('无法读取壁纸缓存'))
    })
  } finally {
    db.close()
  }
}

export async function writeWallpaper(image: Blob) {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(image, WALLPAPER_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error('无法缓存壁纸'))
      transaction.onabort = () => reject(transaction.error || new Error('壁纸缓存已取消'))
    })
  } finally {
    db.close()
  }
}

export async function deleteWallpaper() {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).delete(WALLPAPER_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error('无法清除壁纸缓存'))
      transaction.onabort = () => reject(transaction.error || new Error('清除壁纸缓存已取消'))
    })
  } finally {
    db.close()
  }
}
