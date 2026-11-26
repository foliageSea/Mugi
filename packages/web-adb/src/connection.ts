import {
  Adb,
  AdbDaemonTransport,
  LinuxFileType,
  type AdbSocket,
  type AdbShellProtocolProcess,
} from '@yume-chan/adb'
import {
  AdbDaemonWebUsbDeviceManager,
  type AdbDaemonWebUsbDevice,
} from '@yume-chan/adb-daemon-webusb'
import { ReadableStream } from '@yume-chan/stream-extra'
import type { AndroidApp, RemoteFile, SessionOptions } from './types.js'
import { createCredentialStore, type CredentialStore } from './credentials.js'
import {
  APP_ICON_DIRECTORY,
  MAX_APP_ICON_BYTES,
  appIconCommand,
  loadAppIconHelper,
  parseAppIconVersions,
  validateAppIcon,
  validAppIconPackage,
  type AppIconSource,
} from './app-icons.js'
import { fetchServerBinary, fetchServerDigest, type ServerSource } from './server.js'
import {
  abortable,
  fileName,
  isUnlocked,
  parseApps,
  SERVER_PATH,
  SERVER_VERSION,
  serverCommand,
  serverFileMissing,
  sha256Matches,
  shellQuote,
  storagePath,
} from './helpers.js'

export interface WebUsbScrcpyChannels {
  video: AdbSocket
  audio?: AdbSocket
  control: AdbSocket
  process: AdbShellProtocolProcess
  logs: () => string
  close: () => Promise<void>
}

export interface WebUsbConnectionOptions {
  credentialStore?: CredentialStore
  serverSource?: ServerSource
  appIconSource?: AppIconSource
}

const defaultCredentialStore = createCredentialStore()

async function readText(stream: ReadableStream<Uint8Array>, limit = 8 << 20) {
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for await (const chunk of stream) {
    bytes += chunk.length
    if (bytes > limit) throw new Error('设备输出超过大小限制')
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

async function readIconBytes(stream: ReadableStream<Uint8Array>, limit: number) {
  const parts: ArrayBuffer[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.byteLength
    if (size > limit) throw new Error('设备图标输出超过大小限制')
    parts.push(Uint8Array.from(chunk).buffer)
  }
  return new Blob(parts, { type: 'image/png' })
}

function runShell(adb: Adb, command: string, signal?: AbortSignal, timeout = 15000) {
  return runShellOutput(adb, command, signal, timeout, readText)
}

async function runShellOutput<T>(
  adb: Adb,
  command: string,
  signal: AbortSignal | undefined,
  timeout: number,
  stdoutReader: (stream: ReadableStream<Uint8Array>) => Promise<T>,
  stderrLimit = 8 << 20,
) {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('ADB 命令超时')), timeout)
  let process: AdbShellProtocolProcess | undefined
  try {
    if (!adb.subprocess.shellProtocol) throw new Error('当前设备不支持 ADB Shell v2')
    process = await abortable(
      adb.subprocess.shellProtocol.spawn(command, controller.signal),
      controller.signal,
      (p) => p.kill(),
    )
    const [stdout, stderr, exitCode] = await abortable(
      Promise.all([
        stdoutReader(process.stdout),
        readText(process.stderr, stderrLimit),
        process.exited,
      ]),
      controller.signal,
    )
    if (exitCode !== 0) {
      const stdoutText = typeof stdout === 'string' ? stdout.trim() : ''
      throw new Error(stderr.trim() || stdoutText || `命令失败（${exitCode}）`)
    }
    return stdout
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    await Promise.resolve(process?.kill()).catch(() => {})
  }
}

export class WebUsbConnection {
  readonly serial: string
  readonly disconnected: Promise<void>
  private closed = false
  private closing?: Promise<void>
  private serverReady?: Promise<void>
  private appIconReady?: Promise<string>
  private readonly lifetime = new AbortController()
  private sessions = new Set<WebUsbScrcpyChannels>()
  private powerOwners = new Set<string>()
  private audioOwner?: string
  private sessionCleanups = new Set<() => Promise<void>>()

  private constructor(
    private readonly device: AdbDaemonWebUsbDevice,
    readonly adb: Adb,
    readonly model: string,
    readonly width: number,
    readonly height: number,
    private readonly options: WebUsbConnectionOptions = {},
  ) {
    // Separate physical ADB serials from browser-owned connections, even for the same phone.
    this.serial = `webusb:${adb.serial}`
    this.disconnected = adb.disconnected
      .catch(() => {})
      .then(() => {
        this.closed = true
        this.lifetime.abort()
      })
  }

  static available() {
    return !!AdbDaemonWebUsbDeviceManager.BROWSER && globalThis.isSecureContext === true
  }

  static async request(
    signal?: AbortSignal,
    progress: (message: string) => void = () => {},
    options: WebUsbConnectionOptions = {},
  ) {
    const manager = AdbDaemonWebUsbDeviceManager.BROWSER
    if (!manager || !globalThis.isSecureContext)
      throw new Error('请使用 HTTPS 或 localhost 上的新版 Chrome / Edge')
    // Keep requestDevice in the original click's user activation, before any await.
    const device = await manager.requestDevice()
    signal?.throwIfAborted()
    if (!device) return undefined
    progress('请在手机上允许 USB 调试授权…')
    let adb: Adb | undefined
    const controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    const release = () => {
      void device.raw.close().catch(() => {})
    }
    controller.signal.addEventListener('abort', release, { once: true })
    const timer = setTimeout(
      () => controller.abort(new Error('等待 USB 调试授权超时，请重试')),
      60000,
    )
    try {
      const connection = await abortable(device.connect(), controller.signal, release)
      const transport = await abortable(
        AdbDaemonTransport.authenticate({
          serial: device.serial,
          connection,
          credentialStore: options.credentialStore ?? defaultCredentialStore,
        }),
        controller.signal,
        (t) => t.close(),
      )
      adb = new Adb(transport)
      progress('正在读取设备信息…')
      const model = (await runShell(adb, 'getprop ro.product.model', controller.signal)).trim()
      const size = await runShell(adb, 'wm size', controller.signal)
      const match = size.match(/Physical size:\s*(\d+)x(\d+)/)
      controller.signal.throwIfAborted()
      return new WebUsbConnection(
        device,
        adb,
        model || device.name || device.serial,
        match ? Number(match[1]) : 0,
        match ? Number(match[2]) : 0,
        options,
      )
    } catch (error) {
      await adb?.close().catch(() => {})
      release()
      if (signal?.aborted) throw signal.reason
      throw new Error(
        `USB 连接失败：${error instanceof Error ? error.message : String(error)}。请检查手机授权；若 USB 被占用，请先释放系统 ADB 或关闭其他投屏工具。`,
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      controller.signal.removeEventListener('abort', release)
    }
  }

  claimAudio(id: string) {
    if (this.audioOwner && this.audioOwner !== id) return false
    this.audioOwner = id
    return true
  }
  releaseAudio(id: string) {
    if (this.audioOwner === id) this.audioOwner = undefined
  }
  registerSessionCleanup(cleanup: () => Promise<void>) {
    this.sessionCleanups.add(cleanup)
    return () => this.sessionCleanups.delete(cleanup)
  }
  setPowerOwner(id: string, off: boolean) {
    if (off) this.powerOwners.add(id)
    else this.powerOwners.clear()
  }
  releasePowerOwner(id: string) {
    return this.powerOwners.delete(id) && this.powerOwners.size === 0
  }

  async unlocked(signal?: AbortSignal) {
    const power = await runShell(this.adb, 'dumpsys power', signal)
    const window = await runShell(this.adb, 'dumpsys window', signal)
    return isUnlocked(power, window)
  }

  shell(command: string, signal?: AbortSignal, timeout = 8000) {
    return runShell(this.adb, command, signal, timeout)
  }

  private async remoteServerCurrent(sync: Awaited<ReturnType<Adb['sync']>>, binary: Uint8Array) {
    try {
      if ((await sync.lstat(SERVER_PATH)).size !== BigInt(binary.length)) return false
    } catch {
      return false
    }
    const output = await runShell(this.adb, `sha256sum ${SERVER_PATH}`).catch(() => '')
    return sha256Matches(output, await fetchServerDigest(this.options.serverSource))
  }

  private ensureServer() {
    return (this.serverReady ||= (async () => {
      const binary = await fetchServerBinary(this.options.serverSource)
      await runShell(this.adb, 'mkdir -p /data/local/tmp/mugi')
      const sync = await this.adb.sync()
      try {
        if (await this.remoteServerCurrent(sync, binary)) return
        await sync.write({
          filename: SERVER_PATH,
          file: new ReadableStream({
            start(c) {
              c.enqueue(binary)
              c.close()
            },
          }),
          permission: 0o644,
        })
      } finally {
        await sync.dispose()
      }
    })().catch((error) => {
      this.serverReady = undefined
      throw error
    }))
  }

  /** Read the compact package list once, instead of running dumpsys for every icon. */
  async appIconVersions(signal?: AbortSignal) {
    if (!this.options.appIconSource) return undefined
    const raw = this.device.raw
    const scope = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    const output = await runShell(
      this.adb,
      'user=$(am get-current-user) && echo "$user" && getprop ro.build.fingerprint && pm list packages --user "$user" -f --show-versioncode',
      scope,
    )
    const [user, fingerprint, ...packages] = output.split(/\r?\n/)
    // The WebUSB library's fallback serial is only a vendor/product pair, not a device ID.
    if (!raw.serialNumber || !fingerprint?.trim() || !/^\d+$/.test(user?.trim() || ''))
      return undefined
    return {
      device: JSON.stringify([
        raw.vendorId,
        raw.productId,
        raw.serialNumber,
        fingerprint.trim(),
        user!.trim(),
      ]),
      versions: parseAppIconVersions(packages.join('\n')),
    }
  }

  private ensureAppIconHelper(source: AppIconSource) {
    return (this.appIconReady ||= (async () => {
      // The shared upload outlives a launcher refresh but not the USB connection.
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000)])
      const { bytes, path } = await abortable(loadAppIconHelper(source), signal)
      if (
        (
          await runShell(
            this.adb,
            'if [ -r ' + shellQuote(path) + ' ]; then echo ready; fi',
            signal,
          )
        ).trim() === 'ready'
      )
        return path
      await runShell(this.adb, 'mkdir -p ' + shellQuote(APP_ICON_DIRECTORY), signal)
      const tmp = path + '.' + crypto.randomUUID()
      try {
        const sync = await abortable(this.adb.sync(), signal, (s) => s.dispose())
        try {
          await abortable(
            sync.write({
              filename: tmp,
              file: new ReadableStream({
                start(controller) {
                  controller.enqueue(bytes)
                  controller.close()
                },
              }),
              permission: 0o644,
            }),
            signal,
          )
        } finally {
          await sync.dispose().catch(() => {})
        }
        // Modern Android rejects a writable DEX. Rename only after its write and chmod succeed.
        await runShell(
          this.adb,
          'chmod 444 ' + shellQuote(tmp) + ' && mv -f ' + shellQuote(tmp) + ' ' + shellQuote(path),
          signal,
        )
        return path
      } catch (error) {
        if (!this.closed)
          void runShell(this.adb, 'rm -f ' + shellQuote(tmp), this.lifetime.signal).catch(() => {})
        throw error
      }
    })().catch((error) => {
      this.appIconReady = undefined
      throw error
    }))
  }

  /** Retrieve an Android package icon as binary PNG through a non-PTY Shell v2 stream. */
  async appIcon(pkg: string, signal?: AbortSignal): Promise<Blob | undefined> {
    if (!validAppIconPackage(pkg)) throw new Error('应用包名无效')
    const source = this.options.appIconSource
    if (!source) return undefined
    const scope = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    scope.throwIfAborted()
    const path = await abortable(this.ensureAppIconHelper(source), scope)
    const icon = await runShellOutput(
      this.adb,
      appIconCommand(path, pkg),
      scope,
      8000,
      (stream) => readIconBytes(stream, MAX_APP_ICON_BYTES),
      64 << 10,
    )
    return validateAppIcon(icon)
  }

  async apps(signal?: AbortSignal): Promise<AndroidApp[]> {
    const output = await runShell(
      this.adb,
      'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER',
      signal,
    )
    const packages = new Set<string>()
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^([A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)+)\//)
      if (match) packages.add(match[1])
    }
    try {
      signal?.throwIfAborted()
      await abortable(this.ensureServer(), signal)
      const names = await runShell(
        this.adb,
        `CLASSPATH=${SERVER_PATH} app_process / com.genymobile.scrcpy.Server ${SERVER_VERSION} list_apps=true cleanup=false log_level=info 2>&1`,
        signal,
        60000,
      )
      const apps = parseApps(names, packages)
      if (apps.length) return apps
    } catch {
      signal?.throwIfAborted()
      /* Shell package names remain usable if label extraction fails. */
    }
    return [...packages].map((pkg) => ({
      name: pkg.slice(pkg.lastIndexOf('.') + 1),
      package: pkg,
      system: false,
      launchable: true,
    }))
  }

  async files(path: string, signal?: AbortSignal): Promise<{ files: RemoteFile[]; path: string }> {
    path = storagePath(path)
    signal?.throwIfAborted()
    const sync = await abortable(this.adb.sync(), signal, (s) => s.dispose())
    const cancel = () => {
      void sync.dispose().catch(() => {})
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const entries = await abortable(sync.readdir(path), signal)
      return {
        path,
        files: entries
          .filter((e) => e.name !== '.' && e.name !== '..')
          .map((e) => ({
            name: e.name,
            size: Number(e.size),
            mtime: Number(e.mtime),
            isDir: e.type === LinuxFileType.Directory,
          })),
      }
    } finally {
      signal?.removeEventListener('abort', cancel)
      await sync.dispose().catch(() => {})
    }
  }

  async upload(
    file: File,
    directory: string,
    onProgress: (loaded: number, total: number) => void = () => {},
  ) {
    if (file.name.toLowerCase().endsWith('.apk'))
      return this.install(file, undefined, (value) => onProgress(value.loaded, value.total))
    const path = `${storagePath(directory)}/${fileName(file.name)}`
    const sync = await this.adb.sync()
    const reader = file.stream().getReader()
    let sent = 0
    try {
      await sync.write({
        filename: path,
        file: new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { value, done } = await reader.read()
            if (done) controller.close()
            else {
              sent += value.byteLength
              onProgress(sent, file.size)
              controller.enqueue(value)
            }
          },
          cancel: () => reader.cancel(),
        }),
      })
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      await sync.dispose()
    }
    return { path }
  }

  async install(
    file: File,
    progress: (message: string) => void = () => {},
    onProgress: (value: { loaded: number; total: number }) => void = () => {},
  ) {
    if (!file.name.toLowerCase().endsWith('.apk')) throw new Error('请选择 APK 安装包')
    const path = `/data/local/tmp/mugi/install-${crypto.randomUUID()}.apk`
    progress('正在准备手机存储…')
    await runShell(this.adb, 'mkdir -p /data/local/tmp/mugi')
    try {
      const sync = await this.adb.sync()
      const reader = file.stream().getReader()
      let sent = 0
      try {
        progress('正在通过 USB 发送 APK…')
        await sync.write({
          filename: path,
          file: new ReadableStream<Uint8Array>({
            async pull(controller) {
              const { value, done } = await reader.read()
              if (done) controller.close()
              else {
                sent += value.length
                onProgress({ loaded: sent, total: file.size })
                progress(`正在通过 USB 发送 APK… ${Math.round((sent / file.size) * 100)}%`)
                controller.enqueue(value)
              }
            },
            cancel: () => reader.cancel(),
          }),
        })
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
        await sync.dispose()
      }
      progress('正在手机上安装应用…')
      const output = await runShell(
        this.adb,
        `pm install -r ${shellQuote(path)}`,
        undefined,
        120000,
      )
      if (!/^Success\s*$/m.test(output)) throw new Error(output.trim() || '安装未成功')
      return { output: output.trim() }
    } finally {
      await runShell(this.adb, `rm -f -- ${shellQuote(path)}`).catch(() => {})
    }
  }

  async pull(
    path: string,
    signal?: AbortSignal,
    onProgress: (loaded: number, total: number) => void = () => {},
    expectedSize = 0,
  ) {
    path = storagePath(path)
    signal?.throwIfAborted()
    const sync = await abortable(this.adb.sync(), signal, (s) => s.dispose())
    const cancel = () => {
      void sync.dispose().catch(() => {})
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      // Blob URLs provide previews/downloads without a localhost HTTP file endpoint.
      const parts: ArrayBuffer[] = []
      const reader = sync.read(path).getReader()
      let received = 0
      try {
        for (;;) {
          const { value, done } = await abortable(reader.read(), signal)
          if (done) break
          parts.push(Uint8Array.from(value).buffer)
          received += value.byteLength
          onProgress(received, expectedSize)
        }
      } finally {
        reader.releaseLock()
      }
      const types: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        avif: 'image/avif',
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
        mp3: 'audio/mpeg',
        pdf: 'application/pdf',
      }
      return new Blob(parts, {
        type: types[path.split('.').at(-1)?.toLowerCase() || ''] || 'application/octet-stream',
      })
    } finally {
      signal?.removeEventListener('abort', cancel)
      await sync.dispose().catch(() => {})
    }
  }

  async createDirectory(path: string) {
    path = storagePath(path)
    await runShell(this.adb, `mkdir -- ${shellQuote(path)}`)
    return { path }
  }
  async transferFiles(paths: string[], destination: string, mode: 'copy' | 'move') {
    destination = storagePath(destination)
    const commands = paths.map((item) => {
      const source = storagePath(item)
      const target = `${destination}/${fileName(source.split('/').at(-1) || '')}`
      if (target === source || destination === source || destination.startsWith(`${source}/`))
        throw new Error('不能将项目复制或移动到自身')
      const quoted = shellQuote(target)
      const operation = mode === 'copy' ? 'cp -R' : 'mv'
      return `if [ -e ${quoted} ] || [ -L ${quoted} ]; then echo '目标位置已存在同名项目' >&2; exit 1; fi; ${operation} -- ${shellQuote(source)} ${quoted}`
    })
    await runShell(this.adb, commands.join(' && '), undefined, 120000)
    return { ok: true, count: paths.length }
  }
  async renameFile(path: string, name: string) {
    path = storagePath(path)
    const target = `${path.slice(0, path.lastIndexOf('/'))}/${fileName(name)}`
    const quoted = shellQuote(target)
    await runShell(
      this.adb,
      `if [ -e ${quoted} ] || [ -L ${quoted} ]; then echo '目标名称已存在' >&2; exit 1; fi; mv -- ${shellQuote(path)} ${quoted}`,
    )
    return { path: target }
  }
  async deleteFile(path: string) {
    await runShell(this.adb, `rm -rf -- ${shellQuote(storagePath(path))}`)
    return { ok: true }
  }
  async deleteFiles(paths: string[]) {
    const targets = paths.map((item) => shellQuote(storagePath(item))).join(' ')
    await runShell(this.adb, `rm -rf -- ${targets}`, undefined, 120000)
    return { ok: true, count: paths.length }
  }

  async startSession(opts: SessionOptions, signal?: AbortSignal): Promise<WebUsbScrcpyChannels> {
    signal?.throwIfAborted()
    const controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(
      () => controller.abort(new Error('启动 USB 投屏超时，请检查设备授权和连接')),
      30000,
    )
    try {
      try {
        return await this.openSession(opts, controller.signal)
      } catch (error) {
        if (!serverFileMissing(error instanceof Error ? error.message : '')) throw error
        this.serverReady = undefined
        return await this.openSession(opts, controller.signal)
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
  }

  private async openSession(
    opts: SessionOptions,
    signal: AbortSignal,
  ): Promise<WebUsbScrcpyChannels> {
    if (this.closed) throw new Error('WebUSB 设备已断开')
    const scid = (crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff)
      .toString(16)
      .padStart(8, '0')
    const command = serverCommand(opts, scid)
    await abortable(this.ensureServer(), signal)
    signal?.throwIfAborted()
    if (!this.adb.subprocess.shellProtocol) throw new Error('当前设备不支持 ADB Shell v2')
    const process = await abortable(this.adb.subprocess.shellProtocol.spawn(command), signal, (p) =>
      p.kill(),
    )
    let log = '',
      exited = false
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder()
      try {
        for await (const chunk of stream)
          log = (log + decoder.decode(chunk, { stream: true })).slice(-8192)
      } catch {
        /* disconnected */
      }
    }
    void drain(process.stdout)
    void drain(process.stderr)
    void process.exited.then(
      () => {
        exited = true
      },
      () => {
        exited = true
      },
    )
    const sockets: AdbSocket[] = []
    const cleanup = async () => {
      await Promise.allSettled([
        ...sockets.map((s) => s.close()),
        Promise.resolve().then(() => process.kill()),
      ])
    }
    const connect = async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        signal?.throwIfAborted()
        if (exited) break
        try {
          const socket = await abortable(
            this.adb.createSocket(`localabstract:scrcpy_${scid}`),
            signal,
            (s) => s.close(),
          )
          sockets.push(socket)
          return socket
        } catch {
          signal?.throwIfAborted()
          await abortable(new Promise<void>((resolve) => setTimeout(resolve, 100)), signal)
        }
      }
      throw new Error(`无法连接 scrcpy-server。${log.trim()}`)
    }
    try {
      const video = await connect()
      const audio = opts.audio ? await connect() : undefined
      const control = await connect()
      let closed = false
      const channels: WebUsbScrcpyChannels = {
        video,
        audio,
        control,
        process,
        logs: () => log,
        close: async () => {
          if (closed) return
          closed = true
          this.sessions.delete(channels)
          await cleanup()
        },
      }
      this.sessions.add(channels)
      return channels
    } catch (error) {
      await cleanup()
      throw error
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.lifetime.abort()
    this.closing = (async () => {
      await Promise.allSettled([...this.sessionCleanups].map((cleanup) => cleanup()))
      await Promise.allSettled([...this.sessions].map((s) => s.close()))
      await this.adb.close().catch(() => {})
      await this.device.raw.close().catch(() => {})
    })()
    return this.closing
  }
}

export const connectWebUsb = (
  signal?: AbortSignal,
  progress?: (message: string) => void,
  options?: WebUsbConnectionOptions,
) => WebUsbConnection.request(signal, progress, options)
