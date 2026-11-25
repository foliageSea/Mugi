import { WebUsbConnection, createCredentialStore, isWebUsbSerial } from '@mugi/web-adb'
import appIconDexUrl from '../../../internal/adb/assets/app-icons.dex?url'

export { WebUsbConnection } from '@mugi/web-adb'

const credentialStore = createCredentialStore({
  storageKey: 'mugi.webusb.adb-key.v1',
  name: 'mugi-webusb',
})

async function loadAppIconDex() {
  const response = await fetch(appIconDexUrl)
  if (!response.ok) throw new Error('无法读取应用图标提取器')
  return new Uint8Array(await response.arrayBuffer())
}

export const connectWebUsb = (signal?: AbortSignal, progress?: (message: string) => void) =>
  WebUsbConnection.request(signal, progress, { credentialStore, appIconSource: loadAppIconDex })

let activeConnection: WebUsbConnection | undefined
export function setActiveWebUsbConnection(connection: WebUsbConnection | undefined) {
  activeConnection = connection
}
export function getActiveWebUsbConnection(serial?: string) {
  if (serial !== undefined && activeConnection?.serial !== serial) return undefined
  return activeConnection
}
export function requireWebUsbConnection(serial: string) {
  if (!isWebUsbSerial(serial)) return undefined
  const connection = getActiveWebUsbConnection(serial)
  if (!connection) throw new Error('WebUSB 设备已断开，请重新连接')
  return connection
}
