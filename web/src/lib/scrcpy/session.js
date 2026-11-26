// One browser window <-> one scrcpy session (video/audio/control channels).
import {
  StreamParser,
  DeviceMsgParser,
  ControlEncoder,
  Action,
  VideoPlayer,
  AudioPlayer,
  attachInput,
  KEYCODE,
} from '@mugi/web-adb/scrcpy'
import { wsURL } from '../../services/api'

// A dropped channel is retried with exponential backoff; the server keeps the
// session alive for re-attach, so a hiccup or page reload can resume.
const MAX_RECONNECT_ATTEMPTS = 8

export class Session {
  // hooks: {onDeviceName, onClose, onClipboard, onFirstFrame, onError, onResize,
  //         onReconnecting, onControlReady, onAudioEnd, onDisplayPower}
  constructor(info, canvas, hooks = {}) {
    this.info = info
    this.canvas = canvas
    this.hooks = hooks
    this.sockets = []
    this.closed = false
    this.displayPowerOff = false
    this.wakeTimer = null
    this.frameSize = { width: 0, height: 0 }
    this.reconnectTimers = {}
    this.reconnectAttempts = 0
    this.reconnecting = false
    this.controlReadyOnce = false
    this.player = new VideoPlayer(canvas, {
      onFirstFrame: () => hooks.onFirstFrame && hooks.onFirstFrame(),
      onResize: (w, h) => {
        this.frameSize = { width: w, height: h }
        hooks.onResize && hooks.onResize(w, h)
      },
      onFrameSize: hooks.onFrameSize,
      onRequestKeyFrame: () => this.requestKeyFrame(),
      onError: (error) => this.fail(error),
    })
    this.audio = null
  }

  start() {
    this.detachInput = attachInput(
      this.canvas,
      (msg) => this.send(msg),
      () => this.frameSize,
    )
    this.connectVideo()
    this.connectControl()
    if (this.info.audioCodec) this.connectAudio()
  }

  ws(channel, onMessage, onOpen, onClose) {
    const ws = new WebSocket(wsURL(this.info.id, channel))
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => !this.closed && onOpen && onOpen()
    ws.onmessage = (ev) => {
      if (!this.closed) onMessage(new Uint8Array(ev.data))
    }
    ws.onclose = () => {
      if (this.closed) return
      if (onClose) onClose()
      else this.lostChannel(channel)
    }
    ws.onerror = (e) => console.error('ws error', channel, e)
    this.sockets.push(ws)
    return ws
  }

  lostChannel(channel) {
    if (this.closed) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.close('连接中断，重连失败')
      return
    }
    const delay = Math.min(500 * 2 ** this.reconnectAttempts, 5000)
    this.reconnectAttempts++
    this.setReconnecting(true)
    this.reconnectTimers[channel] = setTimeout(() => {
      if (this.closed) return
      if (channel === 'video') this.connectVideo()
      else if (channel === 'audio') this.connectAudio()
      else this.connectControl()
    }, delay)
  }

  setReconnecting(value) {
    if (this.reconnecting === value) return
    this.reconnecting = value
    if (this.hooks.onReconnecting) this.hooks.onReconnecting(value)
  }

  // Video packets flowing again means the reconnect succeeded.
  noteStreaming() {
    this.reconnectAttempts = 0
    this.setReconnecting(false)
  }

  connectVideo() {
    const parser = new StreamParser(true, (ev) => {
      switch (ev.type) {
        case 'device':
          this.hooks.onDeviceName && this.hooks.onDeviceName(ev.name)
          break
        case 'codec':
          try {
            this.player.configure(ev.codec)
          } catch (e) {
            this.fail(e)
          }
          break
        case 'session':
          this.player.handleSession(ev.width, ev.height)
          break
        case 'packet':
          this.noteStreaming()
          this.player.handlePacket(ev.pts, ev.config, ev.key, ev.payload)
          break
      }
    })
    this.ws(
      'video',
      (data) => parser.push(data),
      () => {
        // After a reconnect the decoder restarts; ask for config + keyframe in
        // case the control channel resumed before the server-side reset.
        if (this.player.codec) this.send(ControlEncoder.resetVideo())
      },
    )
  }

  connectAudio() {
    const parser = new StreamParser(false, (ev) => {
      if (ev.type === 'codec') {
        try {
          if (this.audio) this.audio.close()
          this.audio = new AudioPlayer({ onError: () => {} })
          this.audio.configure(ev.codec)
        } catch (e) {
          console.warn('audio unavailable:', e)
          if (this.audio) this.audio.close()
          this.audio = null
          if (this.hooks.onAudioEnd) this.hooks.onAudioEnd()
        }
      } else if (ev.type === 'packet' && this.audio) {
        this.audio.handlePacket(ev.pts, ev.config, ev.payload)
      }
    })
    this.ws(
      'audio',
      (data) => parser.push(data),
      null,
      () => {
        if (this.audio) this.audio.close()
        this.audio = null
        if (this.hooks.onAudioEnd) this.hooks.onAudioEnd()
        this.lostChannel('audio')
      },
    )
  }

  connectControl() {
    const parser = new DeviceMsgParser((msg) => {
      if (msg.type === 'clipboard' && this.hooks.onClipboard) {
        this.hooks.onClipboard(msg.text)
      }
    })
    this.controlWS = this.ws(
      'control',
      (data) => parser.push(data),
      () => {
        this.hooks.onControlReady && this.hooks.onControlReady()
        // START_APP only on the first connect; a reconnect must not relaunch.
        if (this.controlReadyOnce) return
        this.controlReadyOnce = true
        const startApp = this.info.startApp || this.info.opts?.startApp
        if (startApp) {
          this.send(ControlEncoder.startApp(startApp))
        }
      },
    )
  }

  send(msg) {
    if (this.controlWS && this.controlWS.readyState === WebSocket.OPEN) {
      this.controlWS.send(msg)
      return true
    }
    return false
  }

  setDisplayPower(on) {
    clearTimeout(this.wakeTimer)
    if (on) {
      if (!this.send(ControlEncoder.setDisplayPower(true))) return false
      // Wait out scrcpy's pending keep-display-off task before waking Android.
      this.wakeTimer = setTimeout(() => {
        if (!this.closed) this.send(ControlEncoder.backOrScreenOn(0))
      }, 250)
    } else if (!this.send(ControlEncoder.setDisplayPower(false))) {
      return false
    }
    this.displayPowerOff = !on
    if (this.hooks.onDisplayPower) this.hooks.onDisplayPower(on)
    return true
  }

  wakeScreen() {
    clearTimeout(this.wakeTimer)
    if (!this.send(ControlEncoder.setDisplayPower(true))) return false
    this.displayPowerOff = false
    if (this.hooks.onDisplayPower) this.hooks.onDisplayPower(true)
    // WAKEUP is a no-op when already awake, unlike BACK_OR_SCREEN_ON.
    this.wakeTimer = setTimeout(() => {
      if (this.closed) return
      this.send(ControlEncoder.keycode(Action.down, KEYCODE.WAKEUP, 0, 0))
      this.send(ControlEncoder.keycode(Action.up, KEYCODE.WAKEUP, 0, 0))
    }, 250)
    return true
  }

  async lockScreen() {
    if (this.closed) return false
    if (this.displayPowerOff) {
      if (!this.wakeScreen()) return false
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
    clearTimeout(this.wakeTimer)
    if (this.closed) return false
    const down = this.send(ControlEncoder.keycode(Action.down, KEYCODE.SLEEP, 0, 0))
    const up = this.send(ControlEncoder.keycode(Action.up, KEYCODE.SLEEP, 0, 0))
    if (down && up && this.hooks.onDisplayPower) this.hooks.onDisplayPower(false)
    return down && up
  }

  restoreDisplayPower() {
    return this.displayPowerOff ? this.setDisplayPower(true) : false
  }

  requestKeyFrame() {
    return !this.closed && this.send(ControlEncoder.resetVideo())
  }

  fail(err) {
    console.error('session failed', err)
    this.hooks.onError && this.hooks.onError(err)
    this.close(String(err))
  }

  teardown() {
    for (const timer of Object.values(this.reconnectTimers)) clearTimeout(timer)
    this.reconnectTimers = {}
    clearTimeout(this.wakeTimer)
    this.detachInput?.()
    for (const ws of this.sockets) {
      try {
        ws.close()
      } catch {}
    }
    this.player.close()
    if (this.audio) this.audio.close()
  }

  // detach releases local resources without closing the server-side session
  // and without notifying onClose, so a later page load can re-attach.
  detach() {
    if (this.closed) return
    this.closed = true
    this.teardown()
  }

  close(reason) {
    if (this.closed) return
    this.closed = true
    this.teardown()
    this.hooks.onClose && this.hooks.onClose(reason)
  }
}
