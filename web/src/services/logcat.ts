import {
  openLogcat as usbOpenLogcat,
  clearDeviceLogcat as usbClearDeviceLogcat,
  readLogcatProcesses as usbReadLogcatProcesses,
  type LogcatConnection,
} from '@mugi/web-adb'
import { requireWebUsbConnection } from './webusb'
import { ApiError } from './api'
import { webSocketURL } from './desktop'

export { LOGCAT_COMMAND } from '@mugi/web-adb'
export type { LogcatConnection } from '@mugi/web-adb'

async function query(serial: string, clear: boolean, signal: AbortSignal) {
  const usb = requireWebUsbConnection(serial)
  if (usb) return clear ? usbClearDeviceLogcat(usb, signal) : usbReadLogcatProcesses(usb, signal)
  const response = await fetch(
    `/api/devices/${encodeURIComponent(serial)}/logcat${clear ? '' : '/processes'}`,
    { method: clear ? 'DELETE' : 'GET', signal },
  )
  const data = await response.json()
  if (!response.ok) throw new ApiError(data.error || 'Logcat 操作失败', response.status)
  return (data.output || '') as string
}
export const clearDeviceLogcat = (serial: string, signal: AbortSignal) =>
  query(serial, true, signal)
export const readLogcatProcesses = (serial: string, signal: AbortSignal) =>
  query(serial, false, signal)

export async function openLogcat(
  serial: string,
  signal: AbortSignal,
  output: (bytes: Uint8Array) => void,
  ended: (message: string) => void,
): Promise<LogcatConnection> {
  signal.throwIfAborted()
  const usb = requireWebUsbConnection(serial)
  if (usb) return usbOpenLogcat(usb, signal, output, ended)

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketURL(`/ws/devices/${encodeURIComponent(serial)}/logcat`))
    ws.binaryType = 'arraybuffer'
    let ready = false
    let closed = false
    let reason = 'Logcat 已断开，请检查设备和后端服务'
    const close = () => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      ws.close()
    }
    const fail = (message: string) => {
      if (closed) return
      if (ready) ended(message)
      else reject(new Error(message))
      close()
    }
    const cancel = () => {
      reject(signal.reason)
      close()
    }
    const timer = setTimeout(() => fail('连接 Logcat 超时'), 10000)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    ws.onmessage = (event) => {
      if (closed) return
      try {
        if (event.data instanceof ArrayBuffer) {
          output(new Uint8Array(event.data))
          ws.send(JSON.stringify({ type: 'ack' }))
          return
        }
        const message = JSON.parse(event.data)
        if (message.type === 'ready') {
          ready = true
          clearTimeout(timer)
          resolve({ close })
        } else if (message.type === 'error') fail(message.message)
        else fail('Logcat 协议错误')
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Logcat 协议错误')
      }
    }
    ws.onerror = () => {
      reason = '无法连接 Logcat，当前后端可能不支持此功能或设备已断开'
    }
    ws.onclose = () => fail(reason)
  })
}
