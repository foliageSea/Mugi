import {
  operate as usbOperate,
  screenshot as usbScreenshot,
  exportAPK as usbExportAPK,
  installAPKSet as usbInstallAPKSet,
  operationCommand,
  validateOperationOutput,
  validateScreenshot,
  validPackage,
  type Operation,
  type InstallOptions,
} from '@mugi/web-adb'
import { api, uploadAPKRequest } from './api'
import { requireWebUsbConnection } from './webusb'

export {
  operationCommand,
  validPackage,
  section,
  parseBatteryState,
  parseDeviceInfo,
  parseControlState,
  parsePackages,
  parsePackageInfo,
  parseAPKPaths,
  installError,
} from '@mugi/web-adb'
export type {
  Operation,
  InstallOptions,
  DeviceDetails,
  DeviceControlState,
  BatteryState,
  ManagedApp,
} from '@mugi/web-adb'

const devicePath = (serial: string) => `/api/devices/${encodeURIComponent(serial)}`
async function responseError(response: Response) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `请求失败（${response.status}）`)
  }
  return response
}

export async function operate(
  serial: string,
  operation: Operation,
  value = '',
  signal?: AbortSignal,
) {
  operationCommand(operation, value)
  const usb = requireWebUsbConnection(serial)
  if (usb) return usbOperate(usb, operation, value, signal)
  const response = await responseError(
    await fetch(`${devicePath(serial)}/workbench`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, value }),
      signal,
    }),
  )
  return validateOperationOutput(operation, (await response.json()).output)
}

export async function screenshot(serial: string, signal: AbortSignal): Promise<Blob> {
  const usb = requireWebUsbConnection(serial)
  if (usb) return usbScreenshot(usb, signal)
  return validateScreenshot(
    await (await responseError(await fetch(`${devicePath(serial)}/screenshot`, { signal }))).blob(),
  )
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

export async function exportAPK(serial: string, pkg: string, index: number, signal: AbortSignal) {
  if (!validPackage(pkg)) throw new Error('应用包名无效')
  const usb = requireWebUsbConnection(serial)
  if (usb) return usbExportAPK(usb, pkg, index, signal)
  return (
    await responseError(
      await fetch(`${devicePath(serial)}/packages/${encodeURIComponent(pkg)}/apk?index=${index}`, {
        signal,
      }),
    )
  ).blob()
}

export async function installAPKSet(
  serial: string,
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
  const usb = requireWebUsbConnection(serial)
  if (usb) return usbInstallAPKSet(usb, files, opts, progress)
  if (files.length === 1 && !opts.downgrade && !opts.test)
    return api.install(serial, files[0]!, progress)
  const form = new FormData()
  files.forEach((f) => form.append('files', f))
  form.append('downgrade', String(opts.downgrade))
  form.append('test', String(opts.test))
  progress('正在上传 APK，随后在手机上安装…')
  return uploadAPKRequest(serial, 'install-set', form, progress)
}
