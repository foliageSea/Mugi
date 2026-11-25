import type { AndroidApp, SessionOptions } from './types.js'

export const SERVER_PATH = '/data/local/tmp/mugi/scrcpy-server'
export const SERVER_VERSION = '4.1'
export const isWebUsbSerial = (serial: string) => serial.startsWith('webusb:')
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`

export async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

// An unusable sha256sum (missing applet, odd output) cannot disprove a matching size.
export function sha256Matches(output: string, expected: string) {
  const hash = output.trim().split(/\s+/)[0] || ''
  return !/^[0-9a-f]{64}$/i.test(hash) || hash.toLowerCase() === expected
}

export const serverFileMissing = (log: string) =>
  /ClassNotFoundException|No such file or directory/.test(log)

export function storagePath(path: string) {
  if (!path.startsWith('/sdcard/') || /[\r\n\0]/.test(path))
    throw new Error('路径必须位于手机共享存储目录内')
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2 || parts.some((part) => part === '..' || part === '.'))
    throw new Error('无效的文件路径')
  return '/' + parts.join('/')
}

export function fileName(name: string) {
  if (!name || name === '.' || name === '..' || /[/\r\n\0]/.test(name))
    throw new Error('无效的文件名')
  return name
}

export function parseApps(output: string, launchable: Set<string>): AndroidApp[] {
  const result: AndroidApp[] = []
  let pending: { name: string; system: boolean } | undefined
  const packagePattern = '[A-Za-z0-9_$-]+(?:\\.[A-Za-z0-9_$-]+)+'
  const full = new RegExp(`^\\s*([*-])\\s+(.+?)\\s+(${packagePattern})\\s*$`)
  const pkg = new RegExp(`^\\s*(${packagePattern})\\s*$`)
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(full)
    if (match) {
      result.push({
        name: match[2].trim(),
        package: match[3],
        system: match[1] === '*',
        launchable: launchable.has(match[3]),
      })
      pending = undefined
      continue
    }
    const packageMatch = line.match(pkg)
    if (pending && packageMatch) {
      result.push({
        ...pending,
        package: packageMatch[1],
        launchable: launchable.has(packageMatch[1]),
      })
      pending = undefined
      continue
    }
    const name = line.match(/^\s*([*-])\s+(.+?)\s*$/)
    pending = name ? { name: name[2].trim(), system: name[1] === '*' } : undefined
  }
  return result
}

export function isUnlocked(power: string, window: string) {
  return (
    /^\s*mWakefulness=Awake\s*$/m.test(power) &&
    !/^\s*(isKeyguardShowing|mShowingLockscreen|mDreamingLockscreen)=true\s*$/m.test(window)
  )
}

export function serverCommand(opts: SessionOptions, scid: string) {
  const args = [
    `CLASSPATH=${SERVER_PATH}`,
    'app_process',
    '/',
    'com.genymobile.scrcpy.Server',
    SERVER_VERSION,
    `scid=${scid}`,
    'tunnel_forward=true',
    'log_level=info',
    'cleanup=false',
    'clipboard_autosync=true',
    'power_on=true',
    'video=true',
    'control=true',
    'video_codec=h264',
    `video_bit_rate=${opts.bitRate || 8000000}`,
    `audio=${!!opts.audio}`,
  ]
  if (opts.audio) args.push('audio_codec=opus')
  if (opts.maxSize) args.push(`max_size=${opts.maxSize}`)
  if (opts.mode === 'display') {
    const size = opts.width && opts.height ? `${opts.width}x${opts.height}` : ''
    args.push(
      `new_display=${size}${opts.dpi ? `/${opts.dpi}` : ''}`,
      'keep_active=true',
      'display_ime_policy=local',
    )
    if (opts.flex) args.push('flex_display=true')
    if (!opts.decorations) args.push('vd_system_decorations=false')
  }
  return args.join(' ')
}

// Observe late results as well: an ADB socket/process may be created after cancellation.
export function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  dispose?: (value: T) => unknown,
): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('已取消', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) {
          if (dispose)
            void Promise.resolve()
              .then(() => dispose(value))
              .catch(() => {})
        } else resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}
