import type {
  Capabilities,
  Device,
  AndroidApp,
  SessionOptions,
  SessionInfo,
  RemoteFile,
} from '@/types'
import { requireWebUsbConnection } from './webusb'
import { uploadURL, webSocketURL } from './desktop'

import type { TransferProgress } from '@mugi/web-adb'
export type { TransferProgress } from '@mugi/web-adb'

export interface DesktopADBSettings {
  adbPath: string
  activePath: string
  startupError: string
  restartRequired: boolean
}

export const desktopADB = {
  settings: () => request<DesktopADBSettings>('GET', '/api/desktop/adb'),
  save: (adbPath: string) => request<DesktopADBSettings>('PUT', '/api/desktop/adb', { adbPath }),
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
  }
}
async function request<T>(
  method: string,
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const form = body instanceof FormData
  const response = await fetch(url, {
    method,
    signal,
    headers: body !== undefined && !form ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new ApiError('服务器返回了无法识别的响应', response.status)
  }
  if (!response.ok)
    throw new ApiError(data.error || `请求失败（${response.status}）`, response.status)
  return data as T
}
const devicePath = (serial: string) => `/api/devices/${encodeURIComponent(serial)}`

// XHR exposes upload progress; completion still waits for the Android installer result.
export function uploadAPKRequest(
  serial: string,
  endpoint: 'install' | 'install-set',
  form: FormData,
  progress: (message: string) => void,
  onProgress: (value: TransferProgress) => void = () => {},
) {
  return new Promise<{ output: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', uploadURL(`${devicePath(serial)}/${endpoint}`))
    xhr.timeout = 6 * 60 * 1000
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress({ loaded: event.loaded, total: event.total })
        progress(`正在上传 APK… ${Math.round((event.loaded / event.total) * 100)}%`)
      }
    }
    xhr.upload.onload = () => {
      progress('上传完成，正在手机上安装…')
    }
    xhr.onerror = () => reject(new Error('上传连接中断，请检查设备和后端服务'))
    xhr.ontimeout = () => reject(new Error('等待安装结果超时，请先在手机或应用管理中检查安装结果'))
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText)
        if (xhr.status < 200 || xhr.status >= 300)
          reject(new ApiError(data.error || `安装失败（${xhr.status}）`, xhr.status))
        else resolve(data)
      } catch {
        reject(new Error('服务器返回了无法识别的安装结果'))
      }
    }
    xhr.send(form)
  })
}

async function installAPK(
  serial: string,
  file: File,
  progress: (message: string) => void = () => {},
  onProgress: (value: TransferProgress) => void = () => {},
) {
  const usb = requireWebUsbConnection(serial)
  if (usb) return usb.install(file, progress, onProgress)
  progress('正在上传并安装 APK…')
  const form = new FormData()
  form.append('file', file)
  return uploadAPKRequest(serial, 'install', form, progress, onProgress)
}

function uploadFileRequest(
  serial: string,
  file: File,
  directory: string,
  onProgress: (value: TransferProgress) => void,
) {
  return new Promise<{ path?: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const form = new FormData()
    form.append('file', file)
    form.append('dir', directory)
    xhr.open('POST', uploadURL(`${devicePath(serial)}/push`))
    xhr.timeout = 6 * 60 * 1000
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress({ loaded: event.loaded, total: event.total })
    }
    xhr.onerror = () => reject(new Error('上传连接中断，请检查设备和后端服务'))
    xhr.ontimeout = () => reject(new Error('上传文件超时，请检查设备和后端服务'))
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText)
        if (xhr.status < 200 || xhr.status >= 300)
          reject(new ApiError(data.error || `上传失败（${xhr.status}）`, xhr.status))
        else resolve(data)
      } catch {
        reject(new Error('服务器返回了无法识别的上传结果'))
      }
    }
    xhr.send(form)
  })
}

async function downloadFile(
  serial: string,
  path: string,
  expectedSize: number,
  signal: AbortSignal | undefined,
  onProgress: (value: TransferProgress) => void,
) {
  const usb = requireWebUsbConnection(serial)
  if (usb)
    return usb.pull(
      path,
      signal,
      (loaded, total) => onProgress({ loaded, total: total || expectedSize }),
      expectedSize,
    )

  const response = await fetch(api.pullUrl(serial, path), { signal })
  const contentLength = Number(response.headers.get('content-length'))
  const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : expectedSize
  if (!response.ok) {
    const text = await response.text()
    let message = `下载失败（${response.status}）`
    try {
      message = JSON.parse(text).error || message
    } catch {
      if (text) message = text
    }
    throw new ApiError(message, response.status)
  }
  if (!response.body) {
    const blob = await response.blob()
    onProgress({ loaded: blob.size, total: total || blob.size })
    return blob
  }
  const reader = response.body.getReader()
  const chunks: ArrayBuffer[] = []
  let loaded = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(Uint8Array.from(value).buffer)
      loaded += value.byteLength
      onProgress({ loaded, total })
    }
  } finally {
    reader.releaseLock()
  }
  onProgress({ loaded, total: total || loaded })
  return new Blob(chunks, { type: response.headers.get('content-type') || undefined })
}

export const api = {
  capabilities: () => request<Capabilities>('GET', '/api/capabilities'),
  devices: () => request<{ devices: Device[] }>('GET', '/api/devices'),
  releaseAdb: () => request('POST', '/api/adb/release'),
  disconnect: (serial: string) => request('POST', '/api/devices/disconnect', { serial }),
  apps: async (serial: string, signal?: AbortSignal) => {
    const usb = requireWebUsbConnection(serial)
    if (usb) return usb.apps(signal)
    const { apps } = await request<{ apps?: AndroidApp[] }>(
      'GET',
      `${devicePath(serial)}/apps`,
      undefined,
      signal,
    )
    return apps ?? []
  },
  pair: (host: string, port: number, code: string) =>
    request('POST', '/api/devices/pair', { host, port, code }),
  connect: (host: string, port: number) =>
    request<{ serial: string }>('POST', '/api/devices/connect', { host, port }),
  unlockStatus: async (serial: string, signal?: AbortSignal) => {
    const usb = requireWebUsbConnection(serial)
    if (usb) return { unlocked: await usb.unlocked(signal) }
    return request<{ unlocked: boolean }>(
      'GET',
      `${devicePath(serial)}/unlock-status`,
      undefined,
      signal,
    )
  },
  // Do not abort a creation response: the server may already own a session, which must be stopped explicitly.
  startSession: (serial: string, opts: SessionOptions) =>
    request<SessionInfo>('POST', `${devicePath(serial)}/sessions`, opts),
  stopSession: (id: string) => request('DELETE', `/api/sessions/${encodeURIComponent(id)}`),
  sessions: () => request<{ sessions?: SessionInfo[] }>('GET', '/api/sessions'),
  files: async (serial: string, path = '/sdcard/Download', signal?: AbortSignal) =>
    requireWebUsbConnection(serial)?.files(path, signal) ||
    request<{ files: RemoteFile[]; path: string }>(
      'GET',
      `${devicePath(serial)}/files?path=${encodeURIComponent(path)}`,
      undefined,
      signal,
    ),
  upload: async (
    serial: string,
    file: File,
    directory = '/sdcard/Download',
    onProgress: (value: TransferProgress) => void = () => {},
    status: (message: string) => void = () => {},
  ) => {
    if (file.name.toLowerCase().endsWith('.apk'))
      return installAPK(serial, file, status, onProgress)
    const usb = requireWebUsbConnection(serial)
    if (usb) return usb.upload(file, directory, (loaded, total) => onProgress({ loaded, total }))
    return uploadFileRequest(serial, file, directory, onProgress)
  },
  install: installAPK,
  createDirectory: async (serial: string, path: string) =>
    requireWebUsbConnection(serial)?.createDirectory(path) ||
    request<{ path: string }>('POST', `${devicePath(serial)}/directories`, { path }),
  transferFiles: async (
    serial: string,
    paths: string[],
    destination: string,
    mode: 'copy' | 'move',
  ) =>
    requireWebUsbConnection(serial)?.transferFiles(paths, destination, mode) ||
    request<{ ok: boolean; count: number }>('POST', `${devicePath(serial)}/files/transfer`, {
      paths,
      destination,
      mode,
    }),
  renameFile: async (serial: string, path: string, name: string) =>
    requireWebUsbConnection(serial)?.renameFile(path, name) ||
    request<{ path: string }>('PATCH', `${devicePath(serial)}/files`, { path, name }),
  deleteFile: async (serial: string, path: string) =>
    requireWebUsbConnection(serial)?.deleteFile(path) ||
    request<{ ok: boolean }>('DELETE', `${devicePath(serial)}/files`, { path }),
  deleteFiles: async (serial: string, paths: string[]) =>
    requireWebUsbConnection(serial)?.deleteFiles(paths) ||
    request<{ ok: boolean; count: number }>('DELETE', `${devicePath(serial)}/files`, { paths }),
  fileUrl: async (serial: string, path: string, signal?: AbortSignal) => {
    const usb = requireWebUsbConnection(serial)
    if (usb) return URL.createObjectURL(await usb.pull(path, signal))
    return api.previewUrl(serial, path)
  },
  download: (
    serial: string,
    path: string,
    expectedSize = 0,
    signal?: AbortSignal,
    onProgress: (value: TransferProgress) => void = () => {},
  ) => downloadFile(serial, path, expectedSize, signal, onProgress),
  pullUrl: (serial: string, path: string) =>
    `${devicePath(serial)}/pull?path=${encodeURIComponent(path)}`,
  previewUrl: (serial: string, path: string) =>
    `${devicePath(serial)}/pull?path=${encodeURIComponent(path)}&preview=1`,
}
export function wsURL(id: string, channel: string) {
  return webSocketURL(`/ws/sessions/${encodeURIComponent(id)}/${channel}`)
}
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)
