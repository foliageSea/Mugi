import { definitions, infoCommand } from './resources.js'
import { ReadableStream } from '@yume-chan/stream-extra'
import type { WebUsbConnection } from './connection.js'
import type { InstallOptions } from './types.js'
import { abortable, shellQuote } from './helpers.js'

export type Operation = keyof typeof definitions | 'device-info' | 'reboot'
export const validPackage = (value: string) =>
  value.length <= 255 && /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)

export function operationCommand(operation: Operation, value = '') {
  if (operation === 'device-info' && !value) return infoCommand
  if (operation === 'reboot' && !value) return ''
  const spec = definitions[operation as keyof typeof definitions] as
    { command: string; package?: boolean; choices?: string[]; integer?: number[] } | undefined
  if (!spec) throw new Error('不支持的设备操作')
  const valid = spec.package
    ? validPackage(value)
    : spec.choices
      ? spec.choices.includes(value)
      : spec.integer
        ? /^\d+$/.test(value) &&
          String(Number(value)) === value &&
          Number(value) >= spec.integer[0]! &&
          Number(value) <= spec.integer[1]!
        : value === ''
  if (!valid) throw new Error('设备操作参数无效')
  return spec.command.replaceAll('{value}', shellQuote(value))
}

export async function operate(
  usb: WebUsbConnection,
  operation: Operation,
  value = '',
  signal?: AbortSignal,
) {
  const command = operationCommand(operation, value)
  if (operation === 'reboot') {
    signal?.throwIfAborted()
    await usb.adb.power.reboot()
    return ''
  }
  return validateOperationOutput(operation, await usb.shell(command, signal, 30000))
}

export function validateOperationOutput(operation: Operation, output: string) {
  if (/Failure \[|^Error:|^Security exception:|Unknown command:/m.test(output))
    throw new Error(output.trim())
  if (['app-clear', 'app-uninstall'].includes(operation) && output.trim() !== 'Success')
    throw new Error(output.trim() || '操作未成功')
  return output
}

export function section(raw: string, key: string) {
  return (
    raw
      .replaceAll('\r', '')
      .split(`__${key}__`)[1]
      ?.split(/__[A-Z]+__/)[0]
      ?.trim() || ''
  )
}
export interface DeviceDetails {
  properties: Record<string, string>
  battery: { percent: number | null; temperature: number | null; status: string; power: string }
  storage: { path: string; total: number; used: number; available: number }[]
  display: string
  network: string
  uptime: number | null
  foreground: string
  security: string
  brightness: number | null
}
const numberOrNull = (text: string | undefined) =>
  text !== undefined && text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : null
function formatNetwork(raw: string) {
  const addresses = raw
    .split('\n')
    .map((line) => line.match(/^\s*\d+:\s+(\S+).*?\binet\s+(\S+)/))
    .filter((match): match is RegExpMatchArray => !!match)
    .map((match) => `${match[1]}: ${match[2]!.split('/')[0]}`)
  return addresses.length ? addresses.join('\n') : raw
}
export interface BatteryState {
  percent: number | null
  status: string
  charging: boolean
}
export function parseBatteryState(raw: string): BatteryState {
  const fields = Object.fromEntries(
    [...raw.replaceAll('\r', '').matchAll(/^\s*([^:\n]+):\s*(.*)$/gm)].map((match) => [
      match[1]!.trim(),
      match[2]!.trim(),
    ]),
  )
  const level = numberOrNull(fields.level),
    scale = numberOrNull(fields.scale)
  const statuses: Record<string, string> = {
    '1': '未知',
    '2': '充电中',
    '3': '放电中',
    '4': '未充电',
    '5': '已充满',
  }
  return {
    percent:
      level !== null && scale !== null && scale > 0 && level >= 0 && level <= scale
        ? Math.round((level / scale) * 100)
        : null,
    status: statuses[fields.status || ''] || '状态未知',
    charging: fields.status === '2',
  }
}
export interface DisplayBrightness {
  level: number
  min: number
  max: number
}

export interface DeviceControlState {
  wifi: boolean | null
  wifiConnected: boolean | null
  bluetooth: boolean | null
  airplane: boolean | null
  brightness: number | null
  displayBrightness: DisplayBrightness | null
  autoBrightness: boolean | null
  volume: { level: number; min: number; max: number } | null
}

export function parseControlState(raw: string): DeviceControlState {
  const fields = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z_]+)=(.*)$/)
    if (match) fields.set(match[1]!, match[2]!.trim())
  }
  const bool = (key: string) => {
    const value = fields.get(key)?.toLowerCase()
    if (value === '1' || value === 'true') return true
    if (value === '0' || value === 'false') return false
    return null
  }
  const uint = (value?: string) => {
    if (value === undefined || !/^\d+$/.test(value)) return null
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : null
  }
  const brightness = uint(fields.get('brightness'))
  const display = fields.get('display_brightness')?.split(',') ?? []
  const [displayLevel, displayMin, displayMax] = display.map(numberOrNull)
  const displayBrightness =
    display.length === 3 &&
    displayLevel != null &&
    displayLevel >= 0 &&
    displayLevel <= 1 &&
    displayMin != null &&
    displayMin >= 0 &&
    displayMax != null &&
    displayMax > displayMin &&
    displayMax <= 1
      ? { level: displayLevel, min: displayMin, max: displayMax }
      : null
  const parts = fields.get('volume')?.match(/^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)$/)
  const level = uint(parts?.[1]),
    min = uint(parts?.[2]),
    max = uint(parts?.[3])
  return {
    wifi: bool('wifi'),
    wifiConnected: bool('wifi_connected'),
    bluetooth: bool('bluetooth'),
    airplane: bool('airplane'),
    brightness: brightness !== null && brightness <= 255 ? brightness : null,
    displayBrightness,
    autoBrightness: bool('auto_brightness'),
    volume:
      level !== null && min !== null && max !== null && min <= level && level <= max
        ? { level, min, max }
        : null,
  }
}

export function parseDeviceInfo(raw: string): DeviceDetails {
  const properties = Object.fromEntries(
    [...section(raw, 'PROPERTIES').matchAll(/^\[([^\]]+)\]: \[(.*)\]$/gm)].map((m) => [
      m[1]!,
      m[2]!,
    ]),
  )
  const battery = Object.fromEntries(
    [...section(raw, 'BATTERY').matchAll(/^\s*([^:\n]+):\s*(.*)$/gm)].map((m) => [
      m[1]!.trim(),
      m[2]!.trim(),
    ]),
  )
  const batteryState = parseBatteryState(section(raw, 'BATTERY')),
    temperature = numberOrNull(battery.temperature)
  const storage: DeviceDetails['storage'] = []
  for (const line of section(raw, 'STORAGE').split('\n')) {
    const match = line.match(/^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(\S+)$/)
    if (match)
      storage.push({
        path: match[4]!,
        total: Number(match[1]) * 1024,
        used: Number(match[2]) * 1024,
        available: Number(match[3]) * 1024,
      })
  }
  const foreground = section(raw, 'FOREGROUND').match(/\s([\w.]+)\/[\w.$]+/)?.[1] || ''
  return {
    properties,
    battery: {
      percent: batteryState.percent,
      temperature: temperature === null ? null : temperature / 10,
      status: batteryState.status === '状态未知' ? '不可用' : batteryState.status,
      power:
        ['AC', 'USB', 'Wireless', 'Dock']
          .filter((key) => battery[`${key} powered`] === 'true')
          .join(' / ') ||
        (Object.keys(battery).some((key) => key.endsWith(' powered')) ? '未接电源' : '—'),
    },
    storage,
    display: section(raw, 'DISPLAY'),
    network: formatNetwork(section(raw, 'NETWORK')),
    uptime: numberOrNull(section(raw, 'UPTIME').split(/\s+/)[0]),
    foreground,
    security: section(raw, 'SECURITY'),
    brightness: numberOrNull(section(raw, 'SETTINGS').split('\n')[0]),
  }
}

export interface ManagedApp {
  package: string
  name: string
  system: boolean
  disabled: boolean
}
export function parsePackages(raw: string): ManagedApp[] {
  const list = (key: string) =>
    section(raw, key)
      .split('\n')
      .filter((l) => l.startsWith('package:'))
      .map((l) => l.slice(8).trim())
      .filter(validPackage)
  const system = new Set(list('SYSTEM')),
    disabled = new Set(list('DISABLED'))
  return [...new Set(list('ALL'))].map((pkg) => ({
    package: pkg,
    name: pkg,
    system: system.has(pkg),
    disabled: disabled.has(pkg),
  }))
}
export function parsePackageInfo(raw: string) {
  const value = (name: string) =>
    raw.match(new RegExp(`^\\s*${name}=([^\\n\\r]*)`, 'm'))?.[1]?.trim() || '—'
  return {
    version: value('versionName'),
    code: value('versionCode').split(' ')[0],
    installed: value('firstInstallTime'),
    updated: value('lastUpdateTime'),
    path: value('codePath'),
    minSdk: raw.match(/minSdk=(\d+)/)?.[1] || '—',
    targetSdk: raw.match(/targetSdk=(\d+)/)?.[1] || '—',
  }
}
export function parseAPKPaths(raw: string) {
  return raw
    .split(/\r?\n/)
    .filter((l) => /^package:\/.*\.apk$/.test(l))
    .map((l) => l.slice(8))
}

export async function screenshot(usb: WebUsbConnection, signal: AbortSignal): Promise<Blob> {
  let blob: Blob
  const protocol = usb.adb.subprocess.shellProtocol
  if (!protocol) throw new Error('当前设备不支持 ADB Shell v2')
  const process = await abortable(protocol.spawn('screencap -p', signal), signal, (p) => p.kill())
  const cancel = () => {
    void Promise.resolve(process.kill()).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const collect = async (stream: ReadableStream<Uint8Array>, limit: number) => {
      const chunks: ArrayBuffer[] = []
      let size = 0
      for await (const chunk of stream) {
        size += chunk.length
        if (size > limit) throw new Error('截图输出超过大小限制')
        chunks.push(Uint8Array.from(chunk).buffer)
      }
      return new Blob(chunks)
    }
    const [data, stderr, exit] = await abortable(
      Promise.all([
        collect(process.stdout, 32 << 20),
        collect(process.stderr, 64 << 10),
        process.exited,
      ]),
      signal,
    )
    if (exit !== 0) throw new Error((await stderr.text()) || `截图失败（${exit}）`)
    blob = new Blob([data], { type: 'image/png' })
  } finally {
    signal.removeEventListener('abort', cancel)
    await Promise.resolve(process.kill()).catch(() => {})
  }
  return validateScreenshot(blob)
}

export async function validateScreenshot(blob: Blob) {
  const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer())
  if (signature.join(',') !== '137,80,78,71,13,10,26,10') throw new Error('设备未返回 PNG 截图')
  return blob
}

export async function exportAPK(
  usb: WebUsbConnection,
  pkg: string,
  index: number,
  signal: AbortSignal,
) {
  if (!validPackage(pkg)) throw new Error('应用包名无效')
  const paths = parseAPKPaths(await operate(usb, 'package-paths', pkg, signal))
  const path = paths[index]
  if (!path) throw new Error('APK 文件不存在，请刷新应用详情')
  const sync = await abortable(usb.adb.sync(), signal, (s) => s.dispose())
  const cancel = () => {
    void sync.dispose().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const parts: ArrayBuffer[] = []
    let size = 0
    for await (const chunk of sync.read(path)) {
      signal.throwIfAborted()
      size += chunk.length
      if (size > 512 * 1024 ** 2) throw new Error('WebUSB 单个 APK 导出上限为 512 MB')
      parts.push(Uint8Array.from(chunk).buffer)
    }
    return new Blob(parts, { type: 'application/vnd.android.package-archive' })
  } finally {
    signal.removeEventListener('abort', cancel)
    await sync.dispose().catch(() => {})
  }
}

export function installError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  const reasons: Record<string, string> = {
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: '签名不一致，无法覆盖现有应用。请使用相同签名的安装包。',
    INSTALL_FAILED_VERSION_DOWNGRADE: '安装包版本较旧，可尝试开启允许降级（系统仍可能拒绝）。',
    INSTALL_FAILED_INSUFFICIENT_STORAGE: '手机存储空间不足。',
    INSTALL_FAILED_NO_MATCHING_ABIS: '安装包不支持该设备的 CPU 架构。',
    INSTALL_FAILED_OLDER_SDK: '设备 Android 版本低于应用要求。',
    INSTALL_FAILED_TEST_ONLY: '这是测试安装包，请开启允许测试包。',
    INSTALL_FAILED_MISSING_SPLIT: '缺少 Split APK，请选择全部分包并使用分包安装。',
    INSTALL_FAILED_USER_RESTRICTED: '设备限制安装，请查看手机上的安装授权提示。',
    INSTALL_PARSE_FAILED: '安装包损坏或格式无法解析。',
  }
  const reason = Object.entries(reasons).find(([code]) => text.includes(code))?.[1]
  return reason ? `${reason}\n${text}` : text
}

export async function installAPKSet(
  usb: WebUsbConnection,
  files: File[],
  opts: InstallOptions,
  progress: (message: string) => void,
) {
  if (
    !files.length ||
    files.length > 128 ||
    files.some((f) => !f.size || !f.name.toLowerCase().endsWith('.apk'))
  )
    throw new Error('请选择 1–128 个非空 APK')
  // Preserve the single-APK route for normal installs.
  if (files.length === 1 && !opts.downgrade && !opts.test) return usb.install(files[0]!, progress)
  const dir = `/data/local/tmp/mugi/install-${crypto.randomUUID()}`
  let session = ''
  try {
    await usb.shell(`mkdir -p ${shellQuote(dir)}`)
    const flags = `-r${opts.downgrade ? ' -d' : ''}${opts.test ? ' -t' : ''}`
    const created = await usb.shell(`pm install-create ${flags}`, undefined, 30000)
    session = created.match(/Success.*\[(\d+)\]/)?.[1] || ''
    if (!session) throw new Error(created || '无法创建安装会话')
    for (const [i, file] of files.entries()) {
      const path = `${dir}/${i}.apk`
      const sync = await usb.adb.sync(),
        reader = file.stream().getReader()
      let sent = 0
      try {
        await sync.write({
          filename: path,
          file: new ReadableStream<Uint8Array>({
            async pull(controller) {
              const { done, value } = await reader.read()
              if (done) controller.close()
              else {
                sent += value.length
                progress(
                  `发送 ${file.name} · ${Math.round((sent / file.size) * 100)}% · ${i + 1}/${files.length}`,
                )
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
      const output = await usb.shell(
        `pm install-write -S ${file.size} ${session} ${i}.apk ${shellQuote(path)}`,
        undefined,
        120000,
      )
      if (!/^Success/m.test(output)) throw new Error(output)
    }
    progress('正在提交安装…')
    const output = await usb.shell(`pm install-commit ${session}`, undefined, 120000)
    if (!/^Success\s*$/m.test(output)) throw new Error(output)
    session = ''
    return { output }
  } finally {
    if (session) await usb.shell(`pm install-abandon ${session}`).catch(() => {})
    await usb.shell(`rm -rf -- ${shellQuote(dir)}`).catch(() => {})
  }
}
