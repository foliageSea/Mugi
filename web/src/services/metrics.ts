import { readMetrics as usbReadMetrics, parseSnapshot } from '@mugi/web-adb'
import { requireWebUsbConnection } from './webusb'
import { ApiError } from './api'

export { parseSnapshot, calculateMetrics } from '@mugi/web-adb'
export type { Snapshot, Metrics, MetricSample } from '@mugi/web-adb'

export async function readMetrics(serial: string, signal: AbortSignal) {
  const usb = requireWebUsbConnection(serial)
  if (usb) return usbReadMetrics(usb, signal)
  const response = await fetch(`/api/devices/${encodeURIComponent(serial)}/metrics`, { signal })
  const data = await response.json()
  if (!response.ok) throw new ApiError(data.error || '读取性能指标失败', response.status)
  return parseSnapshot(data.snapshot)
}
