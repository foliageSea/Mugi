export interface OperationDefinition {
  command: string
  package?: boolean
  choices?: string[]
  integer?: number[]
}

export const definitions: Record<
  | 'home'
  | 'back'
  | 'recents'
  | 'wake'
  | 'sleep'
  | 'power'
  | 'volume-up'
  | 'volume-down'
  | 'mute'
  | 'battery'
  | 'settings'
  | 'wifi-settings'
  | 'bluetooth-settings'
  | 'wifi'
  | 'bluetooth'
  | 'airplane'
  | 'stay-awake'
  | 'rotation'
  | 'auto-rotation'
  | 'brightness'
  | 'auto-brightness'
  | 'control-state'
  | 'media-volume'
  | 'packages'
  | 'package-info'
  | 'package-paths'
  | 'app-stop'
  | 'app-clear'
  | 'app-uninstall'
  | 'app-enable'
  | 'app-disable'
  | 'app-settings'
  | 'app-launch',
  OperationDefinition
>
export const infoCommand: string
export const metricsCommand: string
