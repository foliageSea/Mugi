export const MAX_LOGCAT_ROWS = 3000
const MAX_LINE_LENGTH = 8192
export const LOGCAT_LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'] as const
export type LogcatLevel = (typeof LOGCAT_LEVELS)[number]
export interface LogcatRow {
  id: number
  raw: string
  level?: LogcatLevel
  pid?: number
  tid?: number
  tag?: string
}

// Streaming UTF-8 decoder also handles split headers, stack traces and unterminated lines.
export class LogcatParser {
  private decoder = new TextDecoder()
  private partial = ''
  private truncated = false
  private previous?: LogcatRow
  private nextID = 0

  push(bytes: Uint8Array, final = false): LogcatRow[] {
    const text = this.decoder.decode(bytes, { stream: !final })
    const rows: LogcatRow[] = []
    const emit = () => {
      const raw = this.partial.replace(/\r$/, '') + (this.truncated ? ' …[行已截断]' : '')
      this.partial = ''
      this.truncated = false
      if (!raw) return
      const match = raw.match(
        /^(?:\d{4}-)?\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.+?)\s*:\s?(.*)$/,
      )
      let row: LogcatRow
      if (match) {
        row = {
          id: this.nextID++,
          raw,
          pid: Number(match[1]),
          tid: Number(match[2]),
          level: (match[3] === 'A' ? 'F' : match[3]) as LogcatLevel,
          tag: match[4]!.trim(),
        }
        this.previous = row
      } else {
        if (raw.startsWith('---------')) this.previous = undefined
        row = { ...this.previous, id: this.nextID++, raw }
      }
      rows.push(row)
    }
    let offset = 0
    while (offset < text.length) {
      const end = text.indexOf('\n', offset)
      const piece = text.slice(offset, end < 0 ? text.length : end)
      const remaining = MAX_LINE_LENGTH - this.partial.length
      this.partial += piece.slice(0, remaining)
      if (piece.length > remaining) this.truncated = true
      if (end < 0) break
      emit()
      offset = end + 1
    }
    if (final && (this.partial || this.truncated)) emit()
    return rows
  }
}

export function packagePids(output: string, pkg: string): Set<number> {
  const pids = new Set<number>()
  const needle = pkg.toLocaleLowerCase()
  if (!needle) return pids
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\S+)$/)
    if (match && match[2]!.toLocaleLowerCase().includes(needle)) pids.add(Number(match[1]))
  }
  return pids
}

export function filterLogcat(
  rows: LogcatRow[],
  level: string,
  search: string,
  pid: string,
  pids?: Set<number>,
) {
  const minimum = LOGCAT_LEVELS.indexOf(level as LogcatLevel)
  const needle = search.toLocaleLowerCase()
  return rows.filter(
    (row) =>
      (!minimum || (row.level && LOGCAT_LEVELS.indexOf(row.level) >= minimum)) &&
      (!pid || row.pid === Number(pid)) &&
      (!pids || (row.pid !== undefined && pids.has(row.pid))) &&
      (!needle || row.raw.toLocaleLowerCase().includes(needle)),
  )
}
