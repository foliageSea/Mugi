import type { AdbSocket } from '@yume-chan/adb'
import { AudioPlayer, VideoPlayer } from './player.js'
import { attachInput } from './input.js'
import { Action, ControlEncoder, DeviceMsgParser, StreamParser } from './protocol.js'
import { KEYCODE } from './keymap.js'
import type { ScrcpySessionInfo } from '../types.js'
import type { WebUsbConnection, WebUsbScrcpyChannels } from '../connection.js'
import type { MaybeConsumable, WritableStreamDefaultWriter } from '@yume-chan/stream-extra'

export interface WebUsbSessionHooks {
  onDeviceName?: (name: string) => void
  onClose?: (reason?: string) => void
  onClipboard?: (text: string) => void
  onFirstFrame?: () => void
  onError?: (error: unknown) => void
  onResize?: (width: number, height: number) => void
  onAudioEnd?: () => void
  onAudioUnavailable?: () => void
  onDisplayPower?: (on: boolean) => void
  onControlReady?: () => void
  // Reserved for transports with resumable sessions; WebUSB never fires it.
  onReconnecting?: (reconnecting: boolean) => void
}

export class WebUsbSession {
  private channels?: WebUsbScrcpyChannels
  private controlWriter?: WritableStreamDefaultWriter<MaybeConsumable<Uint8Array>>
  private detachInput?: () => void
  private player: VideoPlayer
  private audio: AudioPlayer | null = null
  private closed = false
  private frameSize = { width: 0, height: 0 }
  private sendQueue = Promise.resolve()
  private controller = new AbortController()
  private closing?: Promise<void>
  private unregister: () => void
  private firstFrameTimer?: ReturnType<typeof setTimeout>
  private wakeTimer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly connection: WebUsbConnection,
    private readonly info: ScrcpySessionInfo,
    private readonly canvas: HTMLCanvasElement,
    private readonly hooks: WebUsbSessionHooks = {},
  ) {
    this.unregister = connection.registerSessionCleanup(() => this.close('USB 连接已关闭'))
    this.player = new VideoPlayer(canvas, {
      onFirstFrame: () => {
        clearTimeout(this.firstFrameTimer)
        hooks.onFirstFrame?.()
      },
      onResize: (width: number, height: number) => {
        this.frameSize = { width, height }
        hooks.onResize?.(width, height)
      },
      onRequestKeyFrame: () => this.send(ControlEncoder.resetVideo()),
      onError: (error: unknown) => this.fail(error),
    })
  }

  start() {
    void this.connect().catch((error) => this.fail(error))
  }

  private async connect() {
    const opts = { ...this.info.opts }
    if (opts.audio && !this.connection.claimAudio(this.info.id)) {
      opts.audio = false
      this.hooks.onAudioEnd?.()
      this.hooks.onAudioUnavailable?.()
    }
    const channels = await this.connection.startSession(opts, this.controller.signal)
    if (this.closed) {
      await channels.close()
      return
    }
    this.channels = channels
    this.firstFrameTimer = setTimeout(
      () => this.fail(new Error(`等待视频首帧超时。${channels.logs()}`)),
      20000,
    )
    void channels.process.exited.then(
      () => {
        if (!this.closed) this.fail(new Error(`scrcpy-server 已退出。${channels.logs()}`))
      },
      (error) => this.fail(error),
    )
    this.controlWriter = channels.control.writable.getWriter()
    void this.readVideo(channels.video)
    if (channels.audio) void this.readAudio(channels.audio)
    void this.readControl(channels.control)
    this.detachInput = attachInput(
      this.canvas,
      (message: Uint8Array) => this.send(message),
      () => this.frameSize,
    )
    this.hooks.onControlReady?.()
    if (this.info.opts.startApp) this.send(ControlEncoder.startApp(this.info.opts.startApp))
  }

  private async readVideo(socket: AdbSocket) {
    const parser = new StreamParser(true, (event: any) => {
      if (this.closed) return
      switch (event.type) {
        case 'device':
          this.hooks.onDeviceName?.(event.name)
          break
        case 'codec':
          try {
            this.player.configure(event.codec)
          } catch (error) {
            this.fail(error)
          }
          break
        case 'session':
          this.player.handleSession(event.width, event.height)
          break
        case 'packet':
          this.player.handlePacket(event.pts, event.config, event.key, event.payload)
          break
      }
    })
    try {
      for await (const chunk of socket.readable) {
        if (this.closed) break
        parser.push(chunk)
      }
      if (!this.closed) void this.close('视频通道已断开')
    } catch (error) {
      if (!this.closed) this.fail(error)
    }
  }

  private async readAudio(socket: AdbSocket) {
    const parser = new StreamParser(false, (event: any) => {
      if (this.closed) return
      if (event.type === 'codec') {
        try {
          this.audio = new AudioPlayer({ onError: () => {} })
          this.audio.configure(event.codec)
        } catch (error) {
          console.warn('audio unavailable:', error)
          this.audio?.close()
          this.audio = null
          // Decoder failure doesn't stop Android's audio capture. Keep ownership
          // until the audio channel ends, otherwise a second server steals it.
          this.hooks.onAudioEnd?.()
        }
      } else if (event.type === 'packet' && this.audio) {
        this.audio.handlePacket(event.pts, event.config, event.payload)
      }
    })
    try {
      for await (const chunk of socket.readable) {
        if (this.closed) break
        parser.push(chunk)
      }
    } catch {
      // Audio is optional; a failed audio stream should not close the screen.
    } finally {
      this.audio?.close()
      this.audio = null
      this.connection.releaseAudio(this.info.id)
      this.hooks.onAudioEnd?.()
    }
  }

  private async readControl(socket: AdbSocket) {
    const parser = new DeviceMsgParser((message: any) => {
      if (this.closed) return
      if (message.type === 'clipboard') this.hooks.onClipboard?.(message.text)
    })
    try {
      for await (const chunk of socket.readable) {
        if (this.closed) break
        parser.push(chunk)
      }
      if (!this.closed) void this.close('控制通道已断开')
    } catch (error) {
      if (!this.closed) this.fail(error)
    }
  }

  send(message: Uint8Array) {
    if (!this.controlWriter || this.closed) return false
    const writer = this.controlWriter
    this.sendQueue = this.sendQueue
      .then(async () => {
        if (!this.closed) await writer.write(message)
      })
      .catch((error) => this.fail(error))
    return true
  }

  setDisplayPower(on: boolean) {
    clearTimeout(this.wakeTimer)
    if (on) {
      if (!this.send(ControlEncoder.setDisplayPower(true))) return false
      this.wakeTimer = setTimeout(() => {
        if (!this.closed) this.send(ControlEncoder.backOrScreenOn(0))
      }, 250)
    } else if (!this.send(ControlEncoder.setDisplayPower(false))) {
      return false
    }
    this.connection.setPowerOwner(this.info.id, !on)
    this.hooks.onDisplayPower?.(on)
    return true
  }

  wakeScreen() {
    clearTimeout(this.wakeTimer)
    if (!this.send(ControlEncoder.setDisplayPower(true))) return false
    this.connection.setPowerOwner(this.info.id, false)
    this.hooks.onDisplayPower?.(true)
    this.wakeTimer = setTimeout(() => {
      if (this.closed) return
      this.send(ControlEncoder.keycode(Action.down, KEYCODE.WAKEUP, 0, 0))
      this.send(ControlEncoder.keycode(Action.up, KEYCODE.WAKEUP, 0, 0))
    }, 250)
    return true
  }

  async lockScreen() {
    if (this.closed) return false
    if (this.connection.releasePowerOwner(this.info.id)) {
      if (!this.wakeScreen()) return false
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
    clearTimeout(this.wakeTimer)
    if (this.closed) return false
    const down = this.send(ControlEncoder.keycode(Action.down, KEYCODE.SLEEP, 0, 0))
    const up = this.send(ControlEncoder.keycode(Action.up, KEYCODE.SLEEP, 0, 0))
    if (down && up) this.hooks.onDisplayPower?.(false)
    return down && up
  }

  // detach mirrors Session.detach for the shared window contract. WebUSB
  // channels cannot outlive the page, so detaching is a full close.
  detach(): Promise<void> {
    return this.close('page detached')
  }

  close(reason = 'window closed'): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.controller.abort()
    clearTimeout(this.firstFrameTimer)
    clearTimeout(this.wakeTimer)
    this.detachInput?.()
    this.player.close()
    this.audio?.close()
    this.audio = null
    this.connection.releaseAudio(this.info.id)
    const restorePower = this.connection.releasePowerOwner(this.info.id)
    this.unregister()
    this.closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          (async () => {
            await this.sendQueue
            if (restorePower && this.controlWriter) {
              await this.controlWriter.write(ControlEncoder.setDisplayPower(true))
              await new Promise((resolve) => setTimeout(resolve, 300))
              await this.controlWriter.write(ControlEncoder.backOrScreenOn(0))
            }
          })(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1000)
          }),
        ])
      } catch {
        /* USB may already be unplugged. */
      } finally {
        clearTimeout(timer)
        await this.channels?.close()
        this.controlWriter?.releaseLock()
      }
    })().catch(() => {})
    this.hooks.onClose?.(reason)
    return this.closing
  }

  private fail(error: unknown) {
    if (this.closed) return
    this.hooks.onError?.(error)
    this.close(String(error))
  }
}
