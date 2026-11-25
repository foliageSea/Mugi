// scrcpy v4 wire protocol, browser side.
// Mirrors internal/scrcpy/{control,stream}.go byte for byte.

const PTS_FLAG_CONFIG = 1n << 62n
const PTS_FLAG_KEY = 1n << 61n
const PTS_MASK = ~(7n << 61n)

export const Codec = {
  h264: 'h264',
  h265: 'h265',
  av1: 'av1',
  opus: 'opus',
  aac: 'aac',
  flac: 'flac',
  raw: 'raw',
}

// Incremental parser for a video/audio socket byte stream.
// Events:
//   {type:'device', name}        video socket only
//   {type:'codec', codec}        4-char codec id
//   {type:'session', width, height, resized}   video socket only
//   {type:'packet', pts, config, key, payload:Uint8Array}
//
// Incoming chunks are queued and only merged when a parsed field actually
// spans a chunk boundary, so the steady state (whole packets per message)
// performs zero copies.
export class StreamParser {
  constructor(isVideo, onEvent) {
    this.isVideo = isVideo
    this.onEvent = onEvent
    this.chunks = [] // Uint8Array queue
    this.size = 0 // total buffered bytes
    // States: dummy -> name -> codec -> packets (video); codec -> packets (audio)
    this.state = isVideo ? 'dummy' : 'codec'
    this.packet = null // {header parsed, need payload}
  }

  push(data) {
    if (data.length === 0) return
    this.chunks.push(data)
    this.size += data.length
    this.drain()
  }

  // Consumes n bytes. Returns a zero-copy view when the head chunk covers the
  // range, otherwise merges just those n bytes across chunk boundaries.
  take(n) {
    const head = this.chunks[0]
    let out
    if (head.length >= n) {
      out = head.subarray(0, n)
      if (head.length === n) this.chunks.shift()
      else this.chunks[0] = head.subarray(n)
    } else {
      out = new Uint8Array(n)
      let offset = 0
      while (offset < n) {
        const chunk = this.chunks[0]
        const part = Math.min(chunk.length, n - offset)
        out.set(chunk.subarray(0, part), offset)
        offset += part
        if (part === chunk.length) this.chunks.shift()
        else this.chunks[0] = chunk.subarray(part)
      }
    }
    this.size -= n
    return out
  }

  drain() {
    for (;;) {
      switch (this.state) {
        case 'dummy':
          if (this.size < 1) return
          this.take(1)
          this.state = 'name'
          break
        case 'name': {
          if (this.size < 64) return
          const raw = this.take(64)
          let end = raw.indexOf(0)
          if (end < 0) end = 64
          this.onEvent({ type: 'device', name: new TextDecoder().decode(raw.subarray(0, end)) })
          this.state = 'codec'
          break
        }
        case 'codec': {
          if (this.size < 4) return
          const raw = this.take(4)
          this.onEvent({ type: 'codec', codec: new TextDecoder().decode(raw).replace(/^\0+/, '') })
          this.state = 'packets'
          break
        }
        case 'packets': {
          if (!this.packet) {
            if (this.size < 12) return
            const hdr = this.take(12)
            if (hdr[0] & 0x80) {
              // session packet (video only)
              const dv = new DataView(hdr.buffer, hdr.byteOffset, 12)
              this.onEvent({
                type: 'session',
                width: dv.getUint32(4),
                height: dv.getUint32(8),
                resized: (hdr[3] & 1) !== 0,
              })
              break
            }
            const dv = new DataView(hdr.buffer, hdr.byteOffset, 12)
            const v = dv.getBigUint64(0)
            this.packet = {
              pts: v & PTS_MASK,
              config: (v & PTS_FLAG_CONFIG) !== 0n,
              key: (v & PTS_FLAG_KEY) !== 0n,
              size: dv.getUint32(8),
            }
          }
          if (this.size < this.packet.size) return
          const payload = this.take(this.packet.size)
          const p = this.packet
          this.packet = null
          this.onEvent({ type: 'packet', pts: p.pts, config: p.config, key: p.key, payload })
          break
        }
        default:
          return
      }
    }
  }
}

// Incremental parser for device -> client messages on the control socket.
export class DeviceMsgParser {
  constructor(onMessage) {
    this.onMessage = onMessage
    this.buf = new Uint8Array(0)
  }
  push(data) {
    const merged = new Uint8Array(this.buf.length + data.length)
    merged.set(this.buf, 0)
    merged.set(data, this.buf.length)
    this.buf = merged
    for (;;) {
      if (this.buf.length < 1) return
      const type = this.buf[0]
      if (type === 0) {
        // clipboard
        if (this.buf.length < 5) return
        const n = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(1)
        if (this.buf.length < 5 + n) return
        const text = new TextDecoder().decode(this.buf.subarray(5, 5 + n))
        this.buf = this.buf.subarray(5 + n)
        this.onMessage({ type: 'clipboard', text })
      } else if (type === 1) {
        // ack clipboard
        if (this.buf.length < 9) return
        this.buf = this.buf.subarray(9)
        this.onMessage({ type: 'ack' })
      } else if (type === 2) {
        // uhid output
        if (this.buf.length < 5) return
        const n = new DataView(this.buf.buffer, this.buf.byteOffset).getUint16(3)
        if (this.buf.length < 5 + n) return
        this.buf = this.buf.subarray(5 + n)
      } else {
        console.warn('unknown device message type', type)
        this.buf = this.buf.subarray(1)
      }
    }
  }
}

// Control message encoder (client -> device), same layout as the Go encoder.
export class ControlEncoder {
  static u8(v) {
    return Uint8Array.of(v)
  }

  static keycode(action, keycode, repeat = 0, metastate = 0) {
    const b = new Uint8Array(14)
    const dv = new DataView(b.buffer)
    b[0] = 0
    b[1] = action
    dv.setUint32(2, keycode)
    dv.setUint32(6, repeat)
    dv.setUint32(10, metastate)
    return b
  }

  static text(str) {
    const data = new TextEncoder().encode(str.slice(0, 300))
    const b = new Uint8Array(5 + data.length)
    new DataView(b.buffer).setUint32(1, data.length)
    b[0] = 1
    b.set(data, 5)
    return b
  }

  static touch(action, pointerId, x, y, w, h, pressure, actionButton, buttons) {
    const b = new Uint8Array(32)
    const dv = new DataView(b.buffer)
    b[0] = 2
    b[1] = action
    dv.setBigUint64(2, pointerId)
    dv.setUint32(10, x)
    dv.setUint32(14, y)
    dv.setUint16(18, w)
    dv.setUint16(20, h)
    dv.setUint16(22, Math.round(pressure * 0xffff))
    dv.setUint32(24, actionButton)
    dv.setUint32(28, buttons)
    return b
  }

  static scroll(x, y, w, h, hscroll, vscroll, buttons = 0) {
    const b = new Uint8Array(21)
    const dv = new DataView(b.buffer)
    b[0] = 3
    dv.setUint32(1, x)
    dv.setUint32(5, y)
    dv.setUint16(9, w)
    dv.setUint16(11, h)
    const encode = (value) =>
      value >= 16 ? 0x7fff : value <= -16 ? -0x8000 : Math.round((value / 16) * 0x7fff)
    dv.setInt16(13, encode(hscroll))
    dv.setInt16(15, encode(vscroll))
    dv.setUint32(17, buttons)
    return b
  }

  static backOrScreenOn(action) {
    return Uint8Array.of(4, action)
  }
  static expandNotifications() {
    return Uint8Array.of(5)
  }
  static collapsePanels() {
    return Uint8Array.of(7)
  }
  static getClipboard() {
    return Uint8Array.of(8, 1)
  }

  static setClipboard(seq, paste, str) {
    const data = new TextEncoder().encode(str)
    const b = new Uint8Array(14 + data.length)
    const dv = new DataView(b.buffer)
    b[0] = 9
    dv.setBigUint64(1, seq)
    b[9] = paste ? 1 : 0
    dv.setUint32(10, data.length)
    b.set(data, 14)
    return b
  }

  static setDisplayPower(on) {
    return Uint8Array.of(10, on ? 1 : 0)
  }

  static rotateDevice() {
    return Uint8Array.of(11)
  }

  static startApp(name) {
    const data = new TextEncoder().encode(name.slice(0, 255))
    const b = new Uint8Array(2 + data.length)
    b[0] = 16
    b[1] = data.length
    b.set(data, 2)
    return b
  }

  static resetVideo() {
    return Uint8Array.of(17)
  }

  static restartApp(name) {
    // START_APP's '+' prefix cold-starts on the session's current display.
    if (new TextEncoder().encode(name).length > 254) {
      throw new RangeError('应用包名过长，无法重新启动')
    }
    return this.startApp('+' + name)
  }

  static resizeDisplay(w, h) {
    const b = new Uint8Array(5)
    const dv = new DataView(b.buffer)
    b[0] = 21
    dv.setUint16(1, w)
    dv.setUint16(3, h)
    return b
  }

  static scanFile(p) {
    const data = new TextEncoder().encode(p.slice(0, 256))
    const b = new Uint8Array(5 + data.length)
    b[0] = 22
    new DataView(b.buffer).setUint32(1, data.length)
    b.set(data, 5)
    return b
  }
}

export const Action = { down: 0, up: 1 }
export const Button = { primary: 1, secondary: 2, tertiary: 4 }
export const POINTER_MOUSE = 0xffffffffffffffffn
export const POINTER_FINGER = 0xfffffffffffffffen
