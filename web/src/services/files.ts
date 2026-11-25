import { toast } from 'vue-sonner'
import { api, errorText, type TransferProgress } from './api'

export interface UploadProgress extends TransferProgress {
  fileName: string
  index: number
  count: number
}

export async function uploadFiles(
  serial: string,
  directory: string,
  files: File[],
  progress: (label: string) => void,
  scan?: (path: string) => void,
  onProgress?: (value: UploadProgress) => void,
) {
  let uploaded = 0
  let installed = 0
  let failed = 0
  for (const [index, file] of files.entries()) {
    const apk = file.name.toLowerCase().endsWith('.apk')
    progress(`${apk ? '正在安装' : '正在发送'} ${file.name} · ${index + 1}/${files.length}`)
    try {
      const result = await api.upload(
        serial,
        file,
        directory,
        (value) => onProgress?.({ ...value, fileName: file.name, index, count: files.length }),
        progress,
      )
      if ('path' in result && result.path) scan?.(result.path)
      if (apk) installed++
      else uploaded++
    } catch (error) {
      failed++
      toast.error(`${apk ? '安装' : '发送'} ${file.name} 失败：${errorText(error)}`)
    }
  }
  progress('')
  if (uploaded) toast.success(`已发送 ${uploaded} 个文件到手机`)
  if (installed) toast.success(`已安装 ${installed} 个应用`)
  return { uploaded, installed, failed }
}
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export type RemoteFileKind =
  'folder' | 'image' | 'video' | 'audio' | 'archive' | 'apk' | 'document' | 'file'

const extensions: Record<Exclude<RemoteFileKind, 'folder' | 'file'>, string[]> = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'svg'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'webm', '3gp'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz'],
  apk: ['apk'],
  document: ['pdf', 'txt', 'md', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'json'],
}

export function remoteFileKind(name: string, isDir = false): RemoteFileKind {
  if (isDir) return 'folder'
  const extension = name.split('.').at(-1)?.toLowerCase() || ''
  for (const [kind, values] of Object.entries(extensions)) {
    if (values.includes(extension)) return kind as RemoteFileKind
  }
  return 'file'
}

export function remotePathJoin(directory: string, name: string) {
  return `${directory.replace(/\/$/, '')}/${name}`
}
