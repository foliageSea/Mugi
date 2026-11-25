export interface Device {
  serial: string
  state: string
  model: string
  width?: number
  height?: number
}
import type { AndroidApp, SessionOptions } from '@mugi/web-adb'
export type { AndroidApp, SessionOptions, RemoteFile } from '@mugi/web-adb'
export interface SessionInfo {
  id: string
  serial: string
  opts: SessionOptions
  deviceName: string
  videoCodec: string
  audioCodec?: string
  warning?: string
  transport?: 'adb' | 'webusb'
}
export interface DesktopWindow {
  // Stable UI identity across scrcpy session reconnects.
  id: string
  info: SessionInfo
  app?: AndroidApp
}
export interface Capabilities {
  network: 'local' | 'external'
  adbAllowed: boolean
  webusbAllowed: boolean
}
export type WindowShape = 'portrait' | 'landscape' | 'wide'
