interface DesktopConfig {
  webSocketBase: string
  uploadBase?: string
}

declare global {
  interface Window {
    __MUGI_DESKTOP__?: DesktopConfig
  }
}

// Only the native asset handler sets this marker, before loading Vue. A URL
// parameter must never enable privileged window controls in the browser build.
export const isDesktop = !!window.__MUGI_DESKTOP__

export function webSocketURL(path: string) {
  const base =
    window.__MUGI_DESKTOP__?.webSocketBase ||
    `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`
  return `${base}${path}`
}

export function uploadURL(path: string) {
  const base = window.__MUGI_DESKTOP__?.uploadBase
  return base ? `${base}${path}` : path
}

// Do not import the runtime in browser mode: it installs native drag handlers
// and otherwise tries to call endpoints that do not exist in the web server.
let runtime: Promise<typeof import('@wailsio/runtime')> | undefined
export function desktopRuntime() {
  if (!isDesktop) throw new Error('当前不在桌面应用中')
  return (runtime ??= import('@wailsio/runtime'))
}

export async function toggleNativeMaximise() {
  const { Window } = await desktopRuntime()
  if (await Window.IsMaximised()) await Window.UnMaximise()
  else await Window.Maximise()
}
