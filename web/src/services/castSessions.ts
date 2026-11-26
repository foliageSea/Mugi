import { WebUsbSession, type WebUsbSessionHooks } from '@mugi/web-adb/scrcpy'
import { Session, type SessionHooks } from '@/lib/scrcpy/session.js'
import type { SessionInfo, SessionOptions } from '@/types'
import { api, ApiError } from './api'
import { getActiveWebUsbConnection, requireWebUsbConnection } from './webusb'

export type CastSessionHooks = SessionHooks & WebUsbSessionHooks
export type CastSession = Pick<
  Session,
  'start' | 'detach' | 'send' | 'setDisplayPower' | 'wakeScreen' | 'lockScreen'
> & { close(reason?: string): void | Promise<void> }

export function isDeviceLockedError(error: unknown) {
  return error instanceof ApiError && error.status === 409 && error.message === '请先解锁手机'
}

export async function startCastSession(serial: string, opts: SessionOptions): Promise<SessionInfo> {
  const usb = requireWebUsbConnection(serial)
  if (!usb) return api.startSession(serial, opts)
  // The local session starts when the window attaches its canvas.
  return {
    id: 'webusb-' + crypto.randomUUID(),
    serial,
    opts,
    deviceName: usb.model,
    videoCodec: 'h264',
    audioCodec: opts.audio ? 'opus' : undefined,
    transport: 'webusb',
  }
}

export function createCastSession(
  info: SessionInfo,
  canvas: HTMLCanvasElement,
  hooks: CastSessionHooks,
): CastSession {
  if (canResumeCastSession(info)) return new Session(info, canvas, hooks)
  const usb = getActiveWebUsbConnection(info.serial)
  if (!usb) throw new Error('WebUSB 设备连接已失效，请重新连接')
  return new WebUsbSession(usb, info, canvas, hooks)
}

// Go owns resumable sessions; WebUSB sessions live only in the current page.
export function canResumeCastSession(info: SessionInfo) {
  return info.transport !== 'webusb'
}

export async function stopCastSession(info: SessionInfo, session?: CastSession) {
  try {
    if (canResumeCastSession(info)) await api.stopSession(info.id)
  } finally {
    await session?.close('session stopped')
  }
}
