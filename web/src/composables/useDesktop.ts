import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { useAudioForwarding } from '@/composables/useAudioForwarding'
import { useCastSettings } from '@/composables/useCastSettings'
import { api, errorText } from '@/services/api'
import { isDeviceLockedError, startCastSession, stopCastSession } from '@/services/castSessions'
import { readCachedAppIcon, writeCachedAppIcon } from '@/services/appIconCache'
import { displaySizeForDevice } from '@/lib/scrcpy/window-geometry.js'
import { setActiveWebUsbConnection } from '@/services/webusb'
import type { WebUsbConnection } from '@/services/webusb'
import type { AndroidApp, DesktopWindow, Device, SessionInfo, SessionOptions } from '@/types'

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('已取消', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, 1000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
export function useDesktop() {
  const { audioForwarding } = useAudioForwarding()
  const { castSettings } = useCastSettings()
  const devices = ref<Device[]>([])
  const serial = ref('')
  const allApps = shallowRef<AndroidApp[]>([])
  const apps = computed(() => {
    const launchable = allApps.value.filter((app) => app.launchable)
    return launchable.length ? launchable : allApps.value
  })
  const windows = shallowRef<DesktopWindow[]>([])
  const loadingDevices = ref(false)
  const loadingApps = ref(false)
  const appsError = ref('')
  const launcherOpen = ref(false)
  const appManagerOpen = ref(false)
  const connectOpen = ref(false)
  const filesOpen = ref(false)
  const newWindowOpen = ref(false)
  const starting = ref(false)
  const unlockOpen = ref(false)
  const unlockMessage = ref('等待手机解锁…')
  const webUsb = shallowRef<WebUsbConnection>()
  const initialTransport = (() => {
    const query = new URLSearchParams(location.search).get('transport')
    if (query === 'webusb' || query === 'adb') return query
    try {
      return localStorage.getItem('mugi.transport') === 'webusb' ? 'webusb' : 'adb'
    } catch {
      return 'adb'
    }
  })()
  const transport = ref<'adb' | 'webusb'>(initialTransport)
  const device = computed(() =>
    transport.value === 'webusb' && webUsb.value
      ? {
          serial: webUsb.value.serial,
          state: 'device',
          model: webUsb.value.model,
          width: webUsb.value.width,
          height: webUsb.value.height,
        }
      : devices.value.find((d) => d.serial === serial.value),
  )
  const connected = computed(
    () =>
      (transport.value === 'webusb' && !!webUsb.value) ||
      (transport.value === 'adb' && device.value?.state === 'device'),
  )
  const supportsFiles = computed(() => connected.value)
  let creation: AbortController | undefined
  let appGeneration = 0
  let appRequest: AbortController | undefined
  let iconRequest: AbortController | undefined
  let launchingIcon: string | undefined
  const ownedIconUrls = new Set<string>()
  let disposed = false
  let deviceGeneration = 0
  const switchingTransport = ref(false)
  let disconnectingUsb: Promise<void> | undefined
  const network = ref<'unknown' | 'local' | 'external'>('unknown')
  const adbAllowed = computed(() => network.value === 'local')

  function cancelStart() {
    creation?.abort()
    unlockOpen.value = false
  }
  function releaseUnusedIcons() {
    const inUse = new Set([
      launchingIcon,
      ...allApps.value.map((app) => app.iconUrl),
      ...windows.value.map(({ app }) => app?.iconUrl),
    ])
    for (const url of ownedIconUrls) {
      if (!inUse.has(url)) {
        URL.revokeObjectURL(url)
        ownedIconUrls.delete(url)
      }
    }
  }
  watch(windows, releaseUnusedIcons)

  const iconScope = computed(() =>
    appManagerOpen.value ? 'all' : launcherOpen.value ? 'launcher' : '',
  )
  async function hydrateIcons() {
    if (disposed || !iconScope.value || transport.value !== 'webusb' || iconRequest) return
    const connection = webUsb.value
    if (!connection || connection.serial !== serial.value) return
    const scope = iconScope.value
    const candidates = (scope === 'all' ? allApps.value : apps.value).filter((app) => !app.iconUrl)
    if (!candidates.length) return
    const request = new AbortController()
    const { signal } = request
    const generation = appGeneration
    const current = () =>
      !disposed &&
      !signal.aborted &&
      iconScope.value === scope &&
      generation === appGeneration &&
      transport.value === 'webusb' &&
      webUsb.value === connection &&
      serial.value === connection.serial
    iconRequest = request
    try {
      const metadata = await connection.appIconVersions(signal).catch(() => undefined)
      if (!current()) return
      let next = 0
      const worker = async () => {
        while (current() && next < candidates.length) {
          const app = candidates[next++]!
          const revision = metadata?.versions.get(app.package)
          const device = metadata?.device
          try {
            const cached =
              device && revision
                ? await readCachedAppIcon(device, app.package, revision)
                : undefined
            if (!current()) return
            const icon = cached ?? (await connection.appIcon(app.package, signal))
            if (!current() || !icon) continue
            const url = URL.createObjectURL(icon)
            ownedIconUrls.add(url)
            allApps.value = allApps.value.map((item) =>
              item === app ? { ...item, iconUrl: url } : item,
            )
            if (!cached && device && revision)
              await writeCachedAppIcon(device, app.package, revision, icon)
          } catch {
            // Rendering, USB, and storage failures leave the existing placeholder intact.
          }
        }
      }
      await Promise.all([worker(), worker()])
    } finally {
      if (iconRequest === request) iconRequest = undefined
    }
  }
  function cancelIcons() {
    iconRequest?.abort()
    iconRequest = undefined
  }
  watch(
    iconScope,
    () => {
      cancelIcons()
      void hydrateIcons()
    },
    { flush: 'sync' },
  )

  async function loadApps() {
    const generation = ++appGeneration
    appRequest?.abort()
    cancelIcons()
    const target = serial.value
    const mode = transport.value
    const connection = webUsb.value
    const current = () =>
      !disposed &&
      generation === appGeneration &&
      target === serial.value &&
      mode === transport.value &&
      connection === webUsb.value
    allApps.value = []
    releaseUnusedIcons()
    appsError.value = ''
    if (!target || (mode === 'webusb' && connection?.serial !== target)) {
      loadingApps.value = false
      return
    }
    const request = new AbortController()
    appRequest = request
    loadingApps.value = true
    try {
      const all = await api.apps(target, request.signal)
      if (!current()) return
      allApps.value = all.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans'))
      void hydrateIcons()
    } catch (error) {
      if (current()) appsError.value = errorText(error)
    } finally {
      if (appRequest === request) appRequest = undefined
      if (current()) loadingApps.value = false
    }
  }
  watch([serial, transport, webUsb], () => {
    cancelStart()
    void loadApps()
  })
  async function refreshDevices() {
    if (
      !adbAllowed.value ||
      transport.value === 'webusb' ||
      loadingDevices.value ||
      switchingTransport.value
    )
      return
    const generation = ++deviceGeneration
    loadingDevices.value = true
    try {
      const result = await api.devices()
      if (disposed || generation !== deviceGeneration || transport.value !== 'adb') return
      devices.value = result.devices || []
      if (
        transport.value === 'adb' &&
        !devices.value.some((d) => d.serial === serial.value && d.state === 'device')
      ) {
        serial.value = devices.value.find((d) => d.state === 'device')?.serial || ''
      }
    } catch (error) {
      if (generation !== deviceGeneration || disposed) return
      // Static deployments have no Go API. Offer browser USB without requiring a server.
      connectOpen.value = true
      toast.info(`本地 ADB 服务不可用，可选择 WebUSB 直连：${errorText(error)}`)
    } finally {
      if (generation === deviceGeneration) loadingDevices.value = false
    }
  }
  async function loadCapabilities() {
    try {
      const result = await api.capabilities()
      network.value = result.adbAllowed === true ? 'local' : 'external'
      if (!result.adbAllowed) {
        devices.value = []
        if (transport.value !== 'webusb') {
          transport.value = 'webusb'
          serial.value = ''
        }
      }
    } catch {
      // Fail closed when the capability endpoint is unavailable. WebUSB does
      // not require the Go API and remains usable in static deployments.
      network.value = 'unknown'
      devices.value = []
      if (transport.value !== 'webusb') {
        transport.value = 'webusb'
        serial.value = ''
      }
    }
  }
  async function awaitUnlock(target: string, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted()
      const status = await api.unlockStatus(target, signal)
      signal.throwIfAborted()
      if (status.unlocked) {
        unlockOpen.value = false
        return
      }
      unlockMessage.value = '请在手机上使用密码、指纹或面容解锁。解锁后自动继续。'
      unlockOpen.value = true
      await pause(signal)
    }
  }
  async function startWindow(options: SessionOptions, app?: AndroidApp) {
    if (!connected.value) {
      connectOpen.value = true
      return
    }
    if (starting.value) return
    const target = serial.value
    const duplicate = windows.value.some(
      (w) =>
        w.info.serial === target &&
        w.info.opts.mode === options.mode &&
        (options.mode === 'mirror' || w.info.opts.startApp === options.startApp),
    )
    if (duplicate) {
      const message =
        options.mode === 'mirror'
          ? '该设备已打开一个屏幕镜像窗口'
          : options.startApp
            ? '该应用已打开投屏窗口'
            : '该设备已打开一个未指定应用的投屏窗口'
      toast.info(message)
      return
    }
    const controller = new AbortController()
    creation = controller
    launchingIcon = app?.iconUrl
    starting.value = true
    launcherOpen.value = false
    newWindowOpen.value = false
    const { maxSize, maxFps, bitRateMbps } = castSettings.value
    const opts: SessionOptions = {
      bitRate: bitRateMbps * 1_000_000,
      ...(maxFps ? { maxFps } : {}),
      ...(options.mode === 'mirror' ? { maxSize: maxSize || mirrorMaxSize() } : {}),
      audio:
        audioForwarding.value &&
        !windows.value.some((w) => w.info.serial === target && w.info.audioCodec),
      ...options,
    }
    try {
      for (;;) {
        await awaitUnlock(target, controller.signal)
        controller.signal.throwIfAborted()
        let info: SessionInfo
        try {
          info = await startCastSession(target, opts)
        } catch (error) {
          if (!isDeviceLockedError(error)) throw error
          controller.signal.throwIfAborted()
          unlockOpen.value = true
          await pause(controller.signal)
          continue
        }
        if (controller.signal.aborted || disposed || target !== serial.value) {
          await stopCastSession(info)
          return
        }
        windows.value = [...windows.value, { id: info.id, info, app }]
        if (info.warning) toast(info.warning)
        return
      }
    } catch (error) {
      if (!controller.signal.aborted) toast.error(`无法创建窗口：${errorText(error)}`)
    } finally {
      starting.value = false
      unlockOpen.value = false
      creation = undefined
      launchingIcon = undefined
      releaseUnusedIcons()
    }
  }
  // Pick a mirror long-edge that matches the display the window will be shown
  // on: small screens save encoder effort and battery, large/HiDPI screens
  // stay sharp. The window is height-bound in both device orientations.
  const mirrorMaxSize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const logical = window.screen?.availHeight || 1080
    const target = Math.round((logical * dpr) / 16) * 16
    return Math.max(1280, Math.min(2560, target))
  }
  const mirror = () => {
    const size = displaySizeForDevice(device.value?.width, device.value?.height)
    return startWindow({ mode: 'mirror', ...size })
  }
  const launch = (app: AndroidApp) => {
    const size = displaySizeForDevice(device.value?.width, device.value?.height)
    return startWindow({ mode: 'display', ...size, dpi: 280, startApp: app.package }, app)
  }
  function setWebUsbConnection(connection: WebUsbConnection) {
    webUsb.value = connection
    setActiveWebUsbConnection(connection)
    transport.value = 'webusb'
    serial.value = connection.serial
    void connection.disconnected.then(() => {
      if (disposed || webUsb.value !== connection) return
      cancelStart()
      windows.value = windows.value.filter((w) => w.info.serial !== connection.serial)
      filesOpen.value = false
      webUsb.value = undefined
      setActiveWebUsbConnection(undefined)
      serial.value = ''
      toast.info('WebUSB 设备已断开，请重新选择设备连接')
    })
  }
  function selectAdbDevice(value: string) {
    serial.value = value
  }
  async function disconnectAdbDevice(target: string) {
    await api.disconnect(target)
    if (disposed) return
    // Ignore a scan started before the disconnect, so it can't restore the old row.
    ++deviceGeneration
    loadingDevices.value = false
    devices.value = devices.value.filter((d) => d.serial !== target)
    if (transport.value === 'adb' && serial.value === target) {
      filesOpen.value = false
      serial.value = ''
    }
    await refreshDevices()
  }
  function disconnectWebUsb(): Promise<void> {
    if (disconnectingUsb) return disconnectingUsb
    switchingTransport.value = true
    cancelStart()
    const connection = webUsb.value
    webUsb.value = undefined
    setActiveWebUsbConnection(undefined)
    serial.value = ''
    filesOpen.value = false
    windows.value = windows.value.filter((w) => w.info.transport !== 'webusb')
    disconnectingUsb = Promise.resolve()
      .then(() => connection?.close())
      .finally(() => {
        disconnectingUsb = undefined
        switchingTransport.value = false
      })
    return disconnectingUsb
  }
  async function switchTransport(value: 'adb' | 'webusb') {
    if (value === 'adb' && !adbAllowed.value) return
    if (value === transport.value || switchingTransport.value) return
    cancelStart()
    ++deviceGeneration
    loadingDevices.value = false
    filesOpen.value = false
    transport.value = value
    serial.value = ''
    try {
      localStorage.setItem('mugi.transport', value)
    } catch {
      /* optional preference */
    }
    if (value === 'adb') {
      await disconnectWebUsb()
      if (!disposed && transport.value === 'adb') await refreshDevices()
    }
  }
  function removeWindow(id: string) {
    windows.value = windows.value.filter((w) => w.id !== id)
  }
  // Re-attach screencast sessions that survived a page reload. The server
  // keeps detached sessions alive for a while; WebUSB sessions cannot be
  // restored because they live in the closed page.
  async function restoreSessions() {
    if (transport.value !== 'adb' || !adbAllowed.value) return
    try {
      const { sessions } = await api.sessions()
      if (disposed || !sessions?.length) return
      const known = new Set(windows.value.map((w) => w.info.id))
      const restored = sessions
        .filter((info) => info?.id && !known.has(info.id))
        .map((info) => ({ id: info.id, info: { ...info, transport: 'adb' as const } }))
      if (restored.length) windows.value = [...windows.value, ...restored]
    } catch {
      /* no Go API (static deployment) or nothing to restore */
    }
  }
  function updateWindowSession(id: string, info: SessionInfo) {
    windows.value = windows.value.map((w) => (w.id === id ? { ...w, info } : w))
  }
  onBeforeUnmount(() => {
    disposed = true
    cancelStart()
    appGeneration++
    appRequest?.abort()
    cancelIcons()
    for (const url of ownedIconUrls) URL.revokeObjectURL(url)
    ownedIconUrls.clear()
    deviceGeneration++
    setActiveWebUsbConnection(undefined)
    void webUsb.value?.close()
  })
  return {
    devices,
    adbAllowed,
    loadCapabilities,
    serial,
    apps,
    allApps,
    appManagerOpen,
    windows,
    device,
    connected,
    supportsFiles,
    transport,
    webUsb,
    loadingDevices,
    loadingApps,
    appsError,
    launcherOpen,
    connectOpen,
    filesOpen,
    newWindowOpen,
    starting,
    unlockOpen,
    unlockMessage,
    refreshDevices,
    setWebUsbConnection,
    selectAdbDevice,
    disconnectAdbDevice,
    switchTransport,
    disconnectWebUsb,
    switchingTransport,
    loadApps,
    cancelStart,
    startWindow,
    mirror,
    launch,
    removeWindow,
    restoreSessions,
    updateWindowSession,
  }
}
