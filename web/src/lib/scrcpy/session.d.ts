import type { SessionInfo } from '../../types'
export interface SessionHooks {
  onControlReady?: () => void
  onDeviceName?: (name: string) => void
  onFirstFrame?: () => void
  onResize?: (width: number, height: number) => void
  onClipboard?: (text: string) => void
  onError?: (error: unknown) => void
  onAudioEnd?: () => void
  onDisplayPower?: (on: boolean) => void
  onReconnecting?: (reconnecting: boolean) => void
  onClose?: (reason?: string) => void
}
export class Session {
  constructor(info: SessionInfo, canvas: HTMLCanvasElement, hooks?: SessionHooks)
  info: SessionInfo
  closed: boolean
  displayPowerOff: boolean
  frameSize: { width: number; height: number }
  start(): void
  send(message: Uint8Array): boolean
  setDisplayPower(on: boolean): boolean
  wakeScreen(): boolean
  lockScreen(): Promise<boolean>
  detach(): void
  close(reason?: string): void
}
