export interface AndroidApp {
  name: string
  package: string
  system: boolean
  launchable: boolean
  iconUrl?: string
}

export interface RemoteFile {
  name: string
  size: number
  isDir: boolean
  mtime: number
}

export interface SessionOptions {
  mode: 'mirror' | 'display'
  width?: number
  height?: number
  dpi?: number
  startApp?: string
  maxSize?: number
  /** Frame rate limit (integer 0–120); omitted or 0 means unlimited. */
  maxFps?: number
  bitRate?: number
  audio?: boolean
  flex?: boolean
  decorations?: boolean
}

export interface ScrcpySessionInfo {
  id: string
  opts: SessionOptions
}

export interface TransferProgress {
  loaded: number
  total: number
}

export interface InstallOptions {
  downgrade: boolean
  test: boolean
}
