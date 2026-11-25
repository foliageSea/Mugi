import { metricsCommand } from './resources.js'
import type { WebUsbConnection } from './connection.js'

export interface Snapshot {
  time: number | null
  cpu: { total: number; idle: number } | null
  memory: { total: number; used: number } | null
  network: Record<string, { rx: number; tx: number }>
}
export interface Metrics {
  cpu: number | null
  memory: Snapshot['memory']
  interfaces: { name: string; rx: number | null; tx: number | null }[]
}
export interface MetricSample {
  snapshot: Snapshot
  metrics: Metrics
}

function section(raw: string, name: string) {
  return raw.split(`__${name}__`)[1]?.split('__')[0]?.trim() || ''
}
const valid = (n: number) => Number.isFinite(n) && n >= 0

export function parseSnapshot(raw: string): Snapshot {
  raw = raw.replaceAll('\r', '')
  const uptime = section(raw, 'UPTIME').split(/\s+/)[0]
  const time = uptime ? Number(uptime) : NaN
  const cpuLine = section(raw, 'CPU').match(/^cpu\s+([\d\s]+)$/)
  const counters = cpuLine?.[1]?.trim().split(/\s+/).map(Number) || []
  const cpu =
    counters.length >= 4 && counters.every(valid)
      ? {
          total: counters.slice(0, 8).reduce((sum, n) => sum + n, 0),
          idle: counters[3]! + (counters[4] || 0),
        }
      : null
  const memoryFields = Object.fromEntries(
    [...section(raw, 'MEMORY').matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)].map((m) => [
      m[1]!,
      Number(m[2]) * 1024,
    ]),
  )
  const total = memoryFields.MemTotal
  const available = memoryFields.MemAvailable
  // Do not silently equate free RAM with available RAM (Android uses RAM as cache).
  const memory =
    total && available !== undefined && available <= total
      ? { total, used: total - available }
      : null
  const network: Snapshot['network'] = {}
  for (const line of section(raw, 'NETWORK').split('\n')) {
    const match = line.match(/^\s*([\w.-]+):\s*(.*)$/)
    if (!match) continue
    const values = match[2]!.trim().split(/\s+/).map(Number)
    if (values.length >= 16 && valid(values[0]!) && valid(values[8]!))
      network[match[1]!] = { rx: values[0]!, tx: values[8]! }
  }
  return { time: valid(time) ? time : null, cpu, memory, network }
}

export function calculateMetrics(current: Snapshot, previous?: Snapshot): Metrics {
  const seconds = current.time !== null && previous?.time != null ? current.time - previous.time : 0
  let cpu: number | null = null
  if (seconds > 0 && current.cpu && previous?.cpu) {
    const total = current.cpu.total - previous.cpu.total
    const idle = current.cpu.idle - previous.cpu.idle
    if (total > 0 && idle >= 0 && idle <= total) cpu = (1 - idle / total) * 100
  }
  const interfaces = Object.entries(current.network)
    .filter(([name]) => name !== 'lo')
    .map(([name, counters]) => {
      const before = previous?.network[name]
      const usable = seconds > 0 && before && counters.rx >= before.rx && counters.tx >= before.tx
      return {
        name,
        rx: usable ? (counters.rx - before.rx) / seconds : null,
        tx: usable ? (counters.tx - before.tx) / seconds : null,
      }
    })
  return { cpu, memory: current.memory, interfaces }
}

export async function readMetrics(usb: WebUsbConnection, signal: AbortSignal) {
  return parseSnapshot(await usb.shell(metricsCommand, signal))
}
