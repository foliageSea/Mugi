import type { WebUsbConnection } from './connection.js'
import { abortable } from './helpers.js'

// Keep fixed commands in sync with internal/adb/logcat.go (checked by tests).
export const LOGCAT_COMMAND = "logcat -b main -b system -b crash -v threadtime -T 500 '*:V'"
export const CLEAR_LOGCAT_COMMAND = 'logcat -b main -b system -b crash -c'
export const LOGCAT_PROCESSES_COMMAND = 'ps -A -o PID,NAME'

export const clearDeviceLogcat = (usb: WebUsbConnection, signal: AbortSignal) =>
  usb.shell(CLEAR_LOGCAT_COMMAND, signal)
export const readLogcatProcesses = (usb: WebUsbConnection, signal: AbortSignal) =>
  usb.shell(LOGCAT_PROCESSES_COMMAND, signal)

export interface LogcatConnection {
  close(): void
}

export async function openLogcat(
  usb: WebUsbConnection,
  signal: AbortSignal,
  output: (bytes: Uint8Array) => void,
  ended: (message: string) => void,
): Promise<LogcatConnection> {
  signal.throwIfAborted()
  const protocol = usb.adb.subprocess.shellProtocol
  if (!protocol) throw new Error('当前设备不支持 ADB Shell v2')
  const process = await abortable(protocol.spawn(LOGCAT_COMMAND, signal), signal, (p) => p.kill())
  let closed = false
  let unregister = () => {}
  const close = () => {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', close)
    unregister()
    void Promise.resolve(process.kill()).catch(() => {})
  }
  unregister = usb.registerSessionCleanup(async () => close())
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) close()
  const exit = process.exited.then(
    (code) => code,
    () => -1,
  )
  void (async () => {
    let diagnostic = ''
    try {
      await abortable(
        Promise.all([
          (async () => {
            for await (const bytes of process.stdout) {
              if (closed) break
              output(bytes)
            }
          })(),
          (async () => {
            const decoder = new TextDecoder()
            for await (const bytes of process.stderr) {
              if (closed) break
              diagnostic = (diagnostic + decoder.decode(bytes, { stream: true })).slice(0, 8192)
            }
            diagnostic = (diagnostic + decoder.decode()).slice(0, 8192)
          })(),
        ]),
        signal,
      )
      const code = await abortable(exit, signal)
      if (!closed) ended(diagnostic.trim() || `Logcat 已退出（${code}），请检查设备连接`)
    } catch (error) {
      if (!closed) ended(error instanceof Error ? error.message : String(error))
    } finally {
      close()
    }
  })()
  return { close }
}
