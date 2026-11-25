import { openTerminal as usbOpenTerminal, type TerminalConnection } from '@mugi/web-adb'
import { requireWebUsbConnection } from './webusb'
import { webSocketURL } from './desktop'

export type { TerminalConnection } from '@mugi/web-adb'

export async function openTerminal(
  serial: string,
  rows: number,
  cols: number,
  signal: AbortSignal,
  output: (data: Uint8Array) => Promise<void>,
  ended: (message: string) => void,
): Promise<TerminalConnection> {
  signal.throwIfAborted()
  const usb = requireWebUsbConnection(serial)
  if (usb) return usbOpenTerminal(usb, rows, cols, signal, output, ended)

  return new Promise<TerminalConnection>((resolve, reject) => {
    const ws = new WebSocket(
      webSocketURL(`/ws/devices/${encodeURIComponent(serial)}/terminal?rows=${rows}&cols=${cols}`),
    )
    ws.binaryType = 'arraybuffer'
    let ready = false
    let closed = false
    let reason = '终端已断开，Shell 已退出或设备连接中断'
    const timer = setTimeout(() => {
      reason = '连接终端超时'
      close()
      reject(new Error(reason))
    }, 10000)
    const close = () => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      ws.close()
    }
    const cancel = () => {
      close()
      reject(signal.reason)
    }
    const send = (message: unknown) => {
      if (closed || ws.readyState !== WebSocket.OPEN) throw new Error('终端未连接')
      if (ws.bufferedAmount > 1024 * 1024) throw new Error('终端输入过快，请稍后重试')
      ws.send(JSON.stringify(message))
    }
    signal.addEventListener('abort', cancel, { once: true })
    ws.onmessage = (event) => {
      if (closed) return
      if (event.data instanceof ArrayBuffer) {
        void output(new Uint8Array(event.data))
          .then(() => {
            if (!closed && ws.readyState === WebSocket.OPEN) send({ type: 'ack' })
          })
          .catch(() => close())
        return
      }
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'error') {
          reason = message.message
          reject(new Error(reason))
          close()
        }
        if (message.type === 'ready') {
          ready = true
          clearTimeout(timer)
          resolve({
            write: async (data) => send({ type: 'input', data }),
            resize: async (rows, cols) => send({ type: 'resize', rows, cols }),
            close,
          })
        }
      } catch {
        reason = '终端协议错误'
        close()
        reject(new Error(reason))
      }
    }
    ws.onerror = () => {
      reason = '无法连接 Android 终端，请检查设备和后端服务'
    }
    ws.onclose = () => {
      if (!ready) reject(new Error(reason))
      else if (!closed) ended(reason)
      close()
    }
  })
}
