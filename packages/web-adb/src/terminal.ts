import type { WebUsbConnection } from './connection.js'
import { abortable } from './helpers.js'

export interface TerminalConnection {
  write(data: string): Promise<void>
  resize(rows: number, cols: number): Promise<void>
  close(): void
}

export async function openTerminal(
  usb: WebUsbConnection,
  rows: number,
  cols: number,
  signal: AbortSignal,
  output: (data: Uint8Array) => Promise<void>,
  ended: (message: string) => void,
): Promise<TerminalConnection> {
  signal.throwIfAborted()
  const protocol = usb.adb.subprocess.shellProtocol
  if (!protocol) throw new Error('当前设备不支持 ADB Shell v2')
  const process = await abortable(protocol.pty({ terminalType: 'xterm-256color' }), signal, (p) =>
    p.kill(),
  )
  const writer = process.input.getWriter()
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
  // Observe exit immediately, including a disconnect before output is consumed.
  const exit = process.exited.then(
    (code) => `Shell 已退出（${code}）`,
    () => '设备连接已断开',
  )
  void (async () => {
    try {
      for await (const chunk of process.output) {
        if (closed) break
        await output(chunk)
      }
      if (!closed) ended(await exit)
    } catch (error) {
      if (!closed) ended(String(error))
    } finally {
      close()
    }
  })()
  try {
    await process.resize(rows, cols)
  } catch (error) {
    close()
    throw error
  }
  return {
    write: async (data) => {
      if (!closed) await writer.write(new TextEncoder().encode(data))
    },
    resize: async (rows, cols) => {
      if (!closed) await process.resize(rows, cols)
    },
    close,
  }
}
