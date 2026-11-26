// WebCodecs-based video and audio players.

const KEY_FRAME_RETRY_MS = 1000
const DECODER_RESET_MS = 5000
const VIDEO_RECOVERY_TIMEOUT_MS = 15000

export class VideoPlayer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onError?: (error: unknown) => void, onFirstFrame?: () => void,
   *   onResize?: (width: number, height: number) => void,
   *   onFrameSize?: (width: number, height: number) => void, onRequestKeyFrame?: () => void }} hooks
   */
  constructor(canvas, hooks = {}) {
    this.canvas = canvas
    // alpha:false skips a compositing blend per frame; desynchronized lets the
    // canvas bypass the compositor queue to shave display latency.
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
    this.hooks = hooks
    this.frameWidth = 0
    this.frameHeight = 0
    this.decoder = null
    this.codec = null
    this.width = 0
    this.height = 0
    this.dropping = false
    this.firstFrame = true
    this.codecConfig = null
    this.closed = false
    this.recoveryTimer = null
    this.recoveryStartedAt = null
    this.lastDecoderResetAt = 0
    this.lastKeyFrameRequestAt = -Infinity
  }

  configure(codec) {
    if (this.closed) return
    this.codec = codec
    this.codecConfig = null
    this.clearRecovery()
    this.dropping = true // A new decoder must start at a keyframe.
    this.createDecoder()
  }

  createDecoder() {
    const configs = {
      h264: { codec: 'avc1.42E02A', avc: { format: 'annexb' } },
      h265: { codec: 'hvc1.1.6.L93.90' },
      av1: { codec: 'av01.0.04M.08' },
    }
    const cfg = configs[this.codec]
    if (!cfg) throw new Error('unsupported video codec: ' + this.codec)
    cfg.optimizeForLatency = true
    // A reconnect reconfigures the player: retire the previous decoder first.
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (this.closed || this.decoder !== decoder) frame.close()
        else this.render(frame)
      },
      error: (e) => {
        if (this.closed || this.decoder !== decoder) return
        console.error('VideoDecoder error', e)
        this.reset()
      },
    })
    this.decoder = decoder
    decoder.configure(cfg)
    this.lastDecoderResetAt = Date.now()
  }

  handleSession(width, height) {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.canvas.width = width
    this.canvas.height = height
    if (this.hooks.onResize) this.hooks.onResize(width, height)
  }

  handlePacket(pts, config, key, payload) {
    if (this.closed || !this.codec) return
    if (config) {
      this.codecConfig = payload.slice()
      return
    }
    if (!this.decoder || this.decoder.state !== 'configured') this.reset()
    if (this.closed || this.decoder?.state !== 'configured') return
    // Backpressure: drop delta packets when the decoder lags.
    if (!key && (this.decoder.decodeQueueSize > 8 || this.dropping)) {
      this.beginRecovery()
      return
    }
    try {
      let data = payload
      if (key && this.codecConfig) {
        data = new Uint8Array(this.codecConfig.length + payload.length)
        data.set(this.codecConfig)
        data.set(payload, this.codecConfig.length)
      }
      this.decoder.decode(
        new EncodedVideoChunk({
          type: key ? 'key' : 'delta',
          timestamp: Number(pts),
          data,
        }),
      )
      if (key) {
        this.dropping = false
        this.clearRecovery()
      }
    } catch (e) {
      console.error('decode() failed', e)
      this.reset()
    }
  }

  render(frame) {
    try {
      const { displayWidth, displayHeight } = frame
      if (displayWidth !== this.canvas.width || displayHeight !== this.canvas.height) {
        this.canvas.width = displayWidth
        this.canvas.height = displayHeight
      }
      this.ctx.drawImage(frame, 0, 0, displayWidth, displayHeight)
      if (displayWidth !== this.frameWidth || displayHeight !== this.frameHeight) {
        this.frameWidth = displayWidth
        this.frameHeight = displayHeight
        this.hooks.onFrameSize?.(displayWidth, displayHeight)
      }
      if (this.firstFrame) {
        this.firstFrame = false
        if (this.hooks.onFirstFrame) this.hooks.onFirstFrame()
      }
    } finally {
      frame.close()
    }
  }

  reset() {
    if (this.closed || !this.codec) return
    try {
      // Closed WebCodecs decoders cannot be reused, even after reset().
      this.createDecoder()
      this.beginRecovery()
    } catch (e) {
      this.failRecovery(e)
    }
  }

  beginRecovery() {
    if (this.closed) return
    this.dropping = true
    if (this.recoveryStartedAt === null) {
      this.recoveryStartedAt = Date.now()
      this.lastDecoderResetAt = this.recoveryStartedAt
    }
    this.requestKeyFrame()
    if (this.recoveryTimer === null) {
      this.recoveryTimer = setTimeout(() => this.retryRecovery(), KEY_FRAME_RETRY_MS)
    }
  }

  requestKeyFrame() {
    const now = Date.now()
    if (now - this.lastKeyFrameRequestAt < KEY_FRAME_RETRY_MS) return
    this.lastKeyFrameRequestAt = now
    this.hooks.onRequestKeyFrame?.()
  }

  retryRecovery() {
    this.recoveryTimer = null
    if (this.closed || this.recoveryStartedAt === null) return
    const now = Date.now()
    if (now - this.recoveryStartedAt >= VIDEO_RECOVERY_TIMEOUT_MS) {
      this.failRecovery(new Error('视频恢复超时：未收到可解码的关键帧，请重新打开投屏'))
      return
    }
    if (now - this.lastDecoderResetAt >= DECODER_RESET_MS) this.reset()
    else this.beginRecovery()
  }

  clearRecovery() {
    clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
    this.recoveryStartedAt = null
  }

  failRecovery(error) {
    this.close()
    this.hooks.onError?.(error)
  }

  close() {
    this.closed = true
    this.clearRecovery()
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
  }
}

export class AudioPlayer {
  /** @param {{ onError?: (error: unknown) => void }} hooks */
  constructor(hooks = {}) {
    this.hooks = hooks
    this.decoder = null
    this.ctx = null
    this.nextTime = 0
    this.enabled = false
    this.codec = null
    this.config = null
  }

  configure(codec) {
    const configs = {
      opus: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
      // AAC-LC 48 kHz stereo; description = AudioSpecificConfig 0x11 0x90.
      aac: {
        codec: 'mp4a.40.2',
        sampleRate: 48000,
        numberOfChannels: 2,
        description: new Uint8Array([0x11, 0x90]),
      },
    }
    const cfg = configs[codec]
    if (!cfg) throw new Error('unsupported audio codec: ' + codec)
    this.codec = codec
    this.config = cfg
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 })
    this.decoder = new AudioDecoder({
      output: (data) => this.play(data),
      error: (e) => {
        console.error('AudioDecoder error', e)
        if (this.hooks.onError) this.hooks.onError(e)
      },
    })
    this.decoder.configure(cfg)
    this.enabled = true
    // AudioContext starts suspended until a user gesture.
    this.resumeListeners?.abort()
    this.resumeListeners = new AbortController()
    const resume = () => {
      if (this.ctx.state !== 'closed') this.ctx.resume().catch(() => {})
    }
    const options = { once: true, signal: this.resumeListeners.signal }
    window.addEventListener('pointerdown', resume, options)
    window.addEventListener('keydown', resume, options)
  }

  handlePacket(pts, config, payload) {
    if (!this.enabled || !this.decoder || this.decoder.state === 'closed') return
    if (config) {
      this.config = { ...this.config, description: payload.slice() }
      this.decoder.configure(this.config)
      return
    }
    if (this.decoder.decodeQueueSize > 30) return // drop under pressure
    try {
      this.decoder.decode(
        new EncodedAudioChunk({ type: 'key', timestamp: Number(pts), data: payload }),
      )
    } catch (e) {
      console.error('audio decode() failed', e)
    }
  }

  play(data) {
    try {
      const frames = data.numberOfFrames
      const channels = data.numberOfChannels
      const buffer = this.ctx.createBuffer(channels, frames, data.sampleRate)
      if (data.format.endsWith('-planar')) {
        // Planar formats have one plane per channel. Convert every plane to
        // Float32 so AudioBuffer receives the sample type it expects.
        for (let c = 0; c < channels; c++) {
          const plane = new Float32Array(frames)
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
          buffer.copyToChannel(plane, c)
        }
      } else {
        // Interleaved formats have a single plane containing all channels.
        // De-interleave it before copying into AudioBuffer.
        const interleaved = new Float32Array(frames * channels)
        data.copyTo(interleaved, { planeIndex: 0, format: 'f32' })
        for (let c = 0; c < channels; c++) {
          const plane = new Float32Array(frames)
          for (let i = 0; i < frames; i++) plane[i] = interleaved[i * channels + c]
          buffer.copyToChannel(plane, c)
        }
      }
      const src = this.ctx.createBufferSource()
      src.buffer = buffer
      src.connect(this.ctx.destination)
      const now = this.ctx.currentTime
      // Keep ~60 ms of jitter buffer; resync if we drift too far.
      if (this.nextTime < now || this.nextTime - now > 0.5) this.nextTime = now + 0.06
      src.start(this.nextTime)
      this.nextTime += frames / data.sampleRate
    } finally {
      data.close()
    }
  }

  close() {
    this.enabled = false
    this.resumeListeners?.abort()
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    if (this.ctx) this.ctx.close().catch(() => {})
  }
}
