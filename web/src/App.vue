<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import {
  ChevronDown,
  Image,
  Keyboard,
  LoaderCircle,
  LockKeyhole,
  Moon,
  PanelsTopLeft,
  Settings,
  Smartphone,
  Sun,
} from '@lucide/vue'
import { toast, Toaster } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import AppIcon from '@/components/AppIcon.vue'
import DockIcon from '@/components/DockIcon.vue'
import DeviceControlCenter from '@/components/DeviceControlCenter.vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import AppLauncher from '@/components/AppLauncher.vue'
import DeviceDialog from '@/components/DeviceDialog.vue'
import FileManagerDialog from '@/components/FileManagerDialog.vue'
import InstallAppWindow from '@/components/InstallAppWindow.vue'
import NewWindowDialog from '@/components/NewWindowDialog.vue'
import MirrorWindow from '@/components/MirrorWindow.vue'
import SettingsDialog from '@/components/SettingsDialog.vue'
import WallpaperDialog from '@/components/WallpaperDialog.vue'
import TopbarMetrics from '@/components/TopbarMetrics.vue'
import DesktopWindowControls from '@/components/DesktopWindowControls.vue'
import { isDesktop, toggleNativeMaximise } from '@/services/desktop'
import { connectWebUsb } from '@/services/webusb'
import { api, errorText } from '@/services/api'
import type { MetricSample } from '@/services/metrics'
import { operate, parseBatteryState, type BatteryState } from '@/services/workbench'
import { useDesktop } from '@/composables/useDesktop'
import { useDockMagnification } from '@/composables/useDockMagnification'
import { useWallpaper } from '@/composables/useWallpaper'
import { useTheme } from '@/composables/useTheme'
import { useSuppressNativeTitles } from '@/composables/useSuppressNativeTitles'
import { provideWindowManager } from '@/composables/useWindowManager'

useSuppressNativeTitles()

const DeveloperWindow = defineAsyncComponent(() => import('@/components/DeveloperWindow.vue'))
const DeviceToolsWindow = defineAsyncComponent(() => import('@/components/DeviceToolsWindow.vue'))
const AppManagerWindow = defineAsyncComponent(() => import('@/components/AppManagerWindow.vue'))
const PerformanceWidget = defineAsyncComponent(() => import('@/components/PerformanceWidget.vue'))
const {
  devices,
  serial,
  apps,
  allApps,
  appManagerOpen,
  windows,
  device,
  connected,
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
  loadApps,
  cancelStart,
  startWindow,
  mirror,
  launch,
  removeWindow,
  restoreSessions,
  updateWindowSession,
  supportsFiles,
  setWebUsbConnection,
  selectAdbDevice,
  transport,
  webUsb,
  switchTransport,
  disconnectWebUsb,
  switchingTransport,
  adbAllowed,
  loadCapabilities,
} = useDesktop()
const { theme } = useTheme()
const themeToggleLabel = computed(() => (theme.value === 'light' ? '切换到深色模式' : '切换到亮色模式'))
function toggleTheme() {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
}
const usbBusy = ref(false)
async function captionDoubleClick(event: MouseEvent) {
  if (!isDesktop || !(event.target instanceof Element)) return
  if (getComputedStyle(event.target).getPropertyValue('--wails-draggable').trim() !== 'drag') return
  try {
    await toggleNativeMaximise()
  } catch {
    toast.error('窗口操作失败，请重试')
  }
}
const usbStatus = ref('')
const usbError = ref('')
let usbAttempt: AbortController | undefined
const adbWindowsOpen = computed(() => windows.value.some((w) => w.info.transport !== 'webusb'))
const fileManagerId = 'file-manager'
const installerId = 'app-installer'
const terminalId = 'developer-terminal'
const logcatId = 'developer-logcat'
const shortcutsOpen = ref(false)
const wallpaperOpen = ref(false)
const settingsOpen = ref(false)
const installOpen = ref(false)
const PERFORMANCE_WIDGET_KEY = 'mugi.performance-widget'
function readPerformanceWidget() {
  try {
    return localStorage.getItem(PERFORMANCE_WIDGET_KEY) === 'on'
  } catch {
    return false
  }
}
const performanceOpen = ref(readPerformanceWidget())
watch(performanceOpen, (value) => {
  try {
    localStorage.setItem(PERFORMANCE_WIDGET_KEY, value ? 'on' : 'off')
  } catch {
    /* optional preference */
  }
})
const performanceVisible = computed(
  () => performanceOpen.value && connected.value && !!serial.value,
)
const performanceSample = ref<MetricSample>()
const terminalOpen = ref(false)
const logcatOpen = ref(false)
const deviceToolsOpen = ref(false)
const controlContext = ref(0)
const controlContextKey = computed(() => String(controlContext.value))
const controlsConnected = computed(
  () => connected.value && !!serial.value && !switchingTransport.value,
)
watch([serial, transport, connected, switchingTransport, webUsb], () => controlContext.value++, {
  flush: 'sync',
})
function openDeviceTools() {
  deviceToolsOpen.value = true
  focusWindow('device-tools')
}
function openAppManager() {
  appManagerOpen.value = true
  focusWindow('app-manager')
}
async function deviceRebooted(contextKey: string) {
  if (contextKey !== controlContextKey.value || !controlsConnected.value) return
  const target = serial.value
  const mode = transport.value
  const matches = ({ info }: (typeof windows.value)[number]) =>
    info.serial === target && (info.transport ?? 'adb') === mode
  const sessions = windows.value.filter(matches)
  windows.value = windows.value.filter((window) => !matches(window))
  terminalOpen.value = false
  logcatOpen.value = false
  if (mode === 'webusb') await disconnectWebUsb()
  else {
    await Promise.allSettled(sessions.map((w) => api.stopSession(w.info.id)))
    if (contextKey === controlContextKey.value) await refreshDevices()
  }
}
function openDeveloper(mode: 'terminal' | 'logcat') {
  if (mode === 'terminal') terminalOpen.value = true
  else logcatOpen.value = true
  focusWindow(`developer-${mode}`)
}
function closeDeveloper(mode: 'terminal' | 'logcat') {
  if (mode === 'terminal') terminalOpen.value = false
  else logcatOpen.value = false
}
watch(
  [serial, transport, connected],
  () => {
    performanceSample.value = undefined
    terminalOpen.value = false
    logcatOpen.value = false
    installOpen.value = false
    deviceToolsOpen.value = false
    appManagerOpen.value = false
  },
  { flush: 'sync' },
)
const dock = ref<HTMLElement>()
useDockMagnification(dock)
const { activeId, minimized, windowIds, visibleIds, focusWindow, minimizeWindow, toggleDesktop } =
  provideWindowManager((id) => {
    dock.value
      ?.querySelector<HTMLButtonElement>(`[data-window-id="${id}"]`)
      ?.focus({ preventScroll: true })
  })
const windowRefs = ref<InstanceType<typeof MirrorWindow>[]>([])
const deviceWindowRefs = computed(() => {
  const ids = new Set(
    windows.value
      .filter(
        ({ info }) => info.serial === serial.value && (info.transport ?? 'adb') === transport.value,
      )
      .map(({ id }) => id),
  )
  return windowRefs.value.filter(({ id }) => ids.has(id))
})
async function topbarScreenAction(action: 'wake' | 'off' | 'lock', signal?: AbortSignal) {
  if (!controlsConnected.value || signal?.aborted) return false
  const target = serial.value
  const context = controlContext.value
  const casts = deviceWindowRefs.value
  const controller = casts.find(({ id }) => id === activeId.value) ?? casts[0]
  if (!controller) {
    if (action === 'off') return false
    await operate(target, action === 'wake' ? 'wake' : 'sleep', '', signal)
  } else {
    const success =
      action === 'wake'
        ? controller.wakeScreen(false)
        : action === 'off'
          ? controller.turnScreenOff(false)
          : await controller.lockScreen(false)
    if (!success) throw new Error('请等待当前设备的投屏连接完成后重试。')
  }
  return !signal?.aborted && controlContext.value === context
}
const deviceName = computed(() => device.value?.model?.replaceAll('_', ' ') || '你的手机')
const battery = ref<BatteryState | null>(null)
const batteryPercent = computed(() => battery.value?.percent ?? 0)
const batteryLabel = computed(() =>
  battery.value?.percent === null || battery.value?.percent === undefined
    ? ''
    : `电量 ${battery.value.percent}% · ${battery.value.status}`,
)
watch(
  [serial, connected],
  ([target, isConnected], _previous, onCleanup) => {
    battery.value = null
    if (!target || !isConnected) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const next = parseBatteryState(await operate(target, 'battery', '', controller.signal))
        if (!controller.signal.aborted) battery.value = next.percent === null ? null : next
      } catch {
        if (!controller.signal.aborted) battery.value = null
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 60_000)
      }
    }
    void refresh()
    onCleanup(() => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    })
  },
  { immediate: true },
)
const {
  brightness,
  contrast,
  wallpaperName,
  wallpaperUrl,
  wallpaperStyle,
  hasCustomWallpaper,
  loading: wallpaperLoading,
  load: loadWallpaper,
  replace: replaceWallpaper,
  reset: resetWallpaper,
} = useWallpaper()
function openNewWindow() {
  launcherOpen.value = false
  newWindowOpen.value = true
}
function openFiles() {
  if (!supportsFiles.value) return
  launcherOpen.value = false
  filesOpen.value = true
  focusWindow(fileManagerId)
}
function openInstaller() {
  if (!connected.value) return
  launcherOpen.value = false
  installOpen.value = true
  focusWindow(installerId)
}
function openDevice() {
  launcherOpen.value = false
  connectOpen.value = true
  void refreshDevices()
}
async function chooseWallpaper(file: File) {
  if (!file.type.startsWith('image/')) {
    toast.error('请选择图片文件')
    return
  }
  if (file.size > 20 * 1024 * 1024) {
    toast.error('壁纸图片不能超过 20 MB')
    return
  }
  try {
    await replaceWallpaper(file)
    toast.success('桌面壁纸已更新')
  } catch (error) {
    toast.error(`保存壁纸失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
async function restoreWallpaper() {
  try {
    await resetWallpaper()
    toast.success('已恢复默认壁纸')
  } catch (error) {
    toast.error(`恢复默认壁纸失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
async function selectDevice(value: string) {
  await refreshDevices()
  selectAdbDevice(value)
}
async function selectWebUsb() {
  if (usbBusy.value || webUsb.value || adbWindowsOpen.value || switchingTransport.value) return
  const controller = new AbortController()
  usbAttempt = controller
  usbBusy.value = true
  usbError.value = ''
  usbStatus.value = '请选择 USB 设备…'
  try {
    const connection = await connectWebUsb(controller.signal, (message) => {
      usbStatus.value = message
    })
    if (!connection) return
    if (controller.signal.aborted) {
      await connection.close()
      return
    }
    setWebUsbConnection(connection)
    connectOpen.value = false
    toast.success(`已通过 WebUSB 连接 ${connection.model}`)
  } catch (error) {
    if (!controller.signal.aborted)
      usbError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (usbAttempt === controller) {
      usbBusy.value = false
      usbAttempt = undefined
      usbStatus.value = ''
    }
  }
}
function cancelUsb() {
  usbAttempt?.abort(new DOMException('已取消连接', 'AbortError'))
}
async function chooseTransport(value: 'adb' | 'webusb') {
  cancelUsb()
  usbError.value = ''
  await switchTransport(value)
}
watch(connectOpen, (open) => {
  if (!open) cancelUsb()
})
function shortcut(event: KeyboardEvent) {
  if (event.isComposing || event.repeat) return
  if (
    unlockOpen.value ||
    connectOpen.value ||
    newWindowOpen.value ||
    shortcutsOpen.value ||
    wallpaperOpen.value ||
    settingsOpen.value
  )
    return
  if (
    !launcherOpen.value &&
    document.querySelector('[data-slot="dialog-overlay"][data-state="open"]')
  )
    return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    event.stopPropagation()
    launcherOpen.value = !launcherOpen.value
  } else if (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    event.key.toLowerCase() === 'm' &&
    !launcherOpen.value &&
    activeId.value
  ) {
    event.preventDefault()
    event.stopPropagation()
    minimizeWindow(activeId.value)
  }
}
onMounted(() => {
  void loadCapabilities().then(() => {
    if (adbAllowed.value) {
      void refreshDevices()
      void restoreSessions()
    }
  })
  void loadWallpaper().catch((error) =>
    toast.error(`读取壁纸失败：${error instanceof Error ? error.message : String(error)}`),
  )
  window.addEventListener('keydown', shortcut, true)
})
onBeforeUnmount(() => {
  cancelUsb()
  window.removeEventListener('keydown', shortcut, true)
})
</script>
<template>
  <div
    class="desktop-shell"
    :class="{ 'native-desktop': isDesktop }"
    :data-custom-wallpaper="hasCustomWallpaper"
  >
    <div
      class="desktop-wallpaper"
      :class="{ custom: hasCustomWallpaper }"
      :style="wallpaperStyle"
      aria-hidden="true"
    />
    <header class="desktop-header" @dblclick="captionDoubleClick">
      <button
        class="brand"
        aria-label="打开应用启动器"
        title="Mugi · 打开应用启动器"
        aria-haspopup="dialog"
        :aria-expanded="launcherOpen"
        @click="launcherOpen = true"
      >
        Mugi
      </button>
      <div class="topbar-actions">
        <TopbarMetrics
          :serial="serial"
          :connected="connected"
          :paused="performanceVisible"
          :sample="performanceSample"
        />
        <span
          v-if="battery"
          class="battery-status text-sm font-medium"
          role="img"
          :aria-label="batteryLabel"
          :title="batteryLabel"
        >
          <svg
            class="battery-icon size-4 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect
              class="battery-level"
              x="7"
              :y="21 - (15 * batteryPercent) / 100"
              width="10"
              :height="(15 * batteryPercent) / 100"
              rx="1"
            />
            <rect x="6" y="5" width="12" height="17" rx="2" />
            <path d="M10 2h4" />
            <path v-if="battery.charging" class="battery-charge" d="m12 9-2 4h4l-2 4" />
          </svg>
          <span>{{ battery.percent }}%</span>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          :aria-label="themeToggleLabel"
          :title="themeToggleLabel"
          @click="toggleTheme"
        >
          <Moon v-if="theme === 'light'" class="size-4" aria-hidden="true" />
          <Sun v-else class="size-4" aria-hidden="true" />
        </Button>
        <DeviceControlCenter
          :serial="serial"
          :device-name="deviceName"
          :context-key="controlContextKey"
          :connected="controlsConnected"
          :can-turn-off="deviceWindowRefs.length > 0"
          :screen-action="topbarScreenAction"
          @reboot="deviceRebooted"
        />
        <Button variant="ghost" size="sm" class="device-trigger" @click="openDevice">
          <Smartphone data-icon="inline-start" />
          <span class="device-name">
            {{ deviceName }}{{ transport === 'webusb' ? ' · WebUSB' : '' }}
          </span>
          <span class="connection-dot" :class="{ connected }" />
          <ChevronDown data-icon="inline-end" />
        </Button>
      </div>
      <DesktopWindowControls v-if="isDesktop" />
    </header>
    <main class="desktop-workspace" aria-label="Android 窗口工作区">
      <!-- prettier-ignore -->
      <Transition name="widget-motion" appear>
      <PerformanceWidget
        v-if="performanceVisible"
        :key="serial"
        :serial="serial"
        :device-name="deviceName"
        @sample="performanceSample = $event"
        @close="performanceOpen = false"
      />
      </Transition>
      <!-- prettier-ignore -->
      <TransitionGroup name="window-motion" appear>
      <MirrorWindow
        ref="windowRefs"
        v-for="item in windows"
        :key="item.id"
        :window="item"
        :audio-occupied="
          windows.some(
            (w) => w.id !== item.id && w.info.serial === item.info.serial && !!w.info.audioCodec,
          )
        "
        @close="removeWindow"
        @session-change="updateWindowSession"
      />
      </TransitionGroup>
      <FileManagerDialog
        v-model:open="filesOpen"
        :serial="serial"
        @uploaded="(target, path) => windowRefs.some((window) => window.scanFile(target, path))"
      />
      <InstallAppWindow
        v-model:open="installOpen"
        :serial="serial"
        :device-name="deviceName"
        @installed="loadApps"
      />
      <!-- prettier-ignore -->
      <Transition name="window-motion" appear>
      <DeviceToolsWindow
        v-if="deviceToolsOpen"
        :key="`device-${serial}`"
        :serial="serial"
        :device-name="deviceName"
        @close="deviceToolsOpen = false"
      />
      </Transition>
      <!-- prettier-ignore -->
      <Transition name="window-motion" appear>
      <AppManagerWindow
        v-if="appManagerOpen"
        :key="`apps-${serial}`"
        :serial="serial"
        :device-name="deviceName"
        :apps="allApps"
        @close="appManagerOpen = false"
        @changed="loadApps"
        @install="openInstaller"
      />
      </Transition>
      <!-- prettier-ignore -->
      <Transition name="window-motion" appear>
      <DeveloperWindow
        v-if="terminalOpen"
        :serial="serial"
        mode="terminal"
        @close="closeDeveloper('terminal')"
      />
      </Transition>
      <!-- prettier-ignore -->
      <Transition name="window-motion" appear>
      <DeveloperWindow
        v-if="logcatOpen"
        :serial="serial"
        mode="logcat"
        @close="closeDeveloper('logcat')"
      />
      </Transition>
      <div v-if="starting && !unlockOpen" class="starting-status" role="status">
        <LoaderCircle class="size-4 animate-spin" />
        <span>正在准备窗口…</span>
        <Button variant="ghost" size="xs" @click="cancelStart">取消</Button>
      </div>
    </main>
    <footer class="desktop-footer">
      <nav ref="dock" aria-label="工作区操作" class="desktop-actions">
        <div class="dock-track">
          <Button
            variant="dock"
            size="dock"
            title="应用启动器 · ⌘ / Ctrl K"
            aria-label="应用启动器"
            @click="launcherOpen = true"
          >
            <DockIcon name="launcher" />
          </Button>
          <Button
            variant="dock"
            size="dock"
            title="镜像屏幕"
            aria-label="镜像屏幕"
            :disabled="!connected || starting"
            @click="mirror"
          >
            <DockIcon name="mirror" />
          </Button>
          <Button
            variant="dock"
            size="dock"
            :data-running="filesOpen"
            :data-active="activeId === fileManagerId"
            :data-window-id="fileManagerId"
            title="文件管理器"
            aria-label="文件管理器"
            :disabled="!connected || !supportsFiles"
            @click="openFiles"
          >
            <DockIcon name="files" />
          </Button>
          <Button
            variant="dock"
            size="dock"
            :data-running="installOpen"
            :data-active="activeId === installerId"
            :data-minimized="minimized.includes(installerId)"
            :data-window-id="installerId"
            title="安装应用"
            aria-label="安装应用"
            :disabled="!connected"
            @click="openInstaller"
          >
            <DockIcon name="installer" />
          </Button>
          <Button
            variant="dock"
            size="dock"
            :data-running="performanceVisible"
            :title="performanceOpen ? '隐藏性能监控小组件' : '显示性能监控小组件'"
            aria-label="性能监控"
            :aria-pressed="performanceOpen"
            :disabled="!connected"
            @click="performanceOpen = !performanceOpen"
          >
            <DockIcon name="performance" />
          </Button>
          <Button
            variant="dock"
            size="dock"
            :data-running="terminalOpen"
            :data-active="activeId === terminalId"
            :data-window-id="terminalId"
            title="终端"
            aria-label="终端"
            :disabled="!connected"
            @click="openDeveloper('terminal')"
          >
            <DockIcon name="terminal" />
          </Button>
          <Button
            variant="dock"
            size="dock"
            :data-running="deviceToolsOpen"
            :data-active="activeId === 'device-tools'"
            data-window-id="device-tools"
            title="关于设备"
            aria-label="关于设备"
            :disabled="!connected"
            @click="openDeviceTools"
          >
            <DockIcon name="device" />
          </Button>
          <Button
            variant="dock"
            size="dock"
            :data-running="appManagerOpen"
            :data-active="activeId === 'app-manager'"
            data-window-id="app-manager"
            title="应用管理"
            aria-label="应用管理"
            :disabled="!connected"
            @click="openAppManager"
          >
            <DockIcon name="apps" />
          </Button>
          <Button
            variant="dock"
            size="dock"
            :data-running="logcatOpen"
            :data-active="activeId === logcatId"
            :data-window-id="logcatId"
            title="Logcat"
            aria-label="Logcat"
            :disabled="!connected"
            @click="openDeveloper('logcat')"
          >
            <DockIcon name="logcat" />
          </Button>
          <Separator v-if="windows.length" orientation="vertical" class="mx-1 self-center h-9" />
          <Button
            v-for="item in windows"
            :key="item.id"
            variant="dock"
            size="dock"
            :data-window-id="item.id"
            data-running="true"
            :data-active="activeId === item.id"
            :data-minimized="minimized.includes(item.id)"
            :aria-label="`${minimized.includes(item.id) ? '恢复' : '切换到'} ${item.app?.name || '镜像屏幕'} 窗口`"
            :title="`${item.app?.name || '镜像屏幕'}${minimized.includes(item.id) ? ' · 已最小化' : ''}`"
            @click="focusWindow(item.id)"
          >
            <AppIcon v-if="item.app" :name="item.app.name" :package="item.app.package" />
            <DockIcon v-else name="mirror" />
          </Button>
        </div>
      </nav>
      <div class="desktop-utilities-card">
        <div class="desktop-utilities">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="桌面与壁纸"
            title="桌面与壁纸"
            @click="wallpaperOpen = true"
          >
            <Image />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            :disabled="!windowIds.length"
            :aria-label="visibleIds.length ? '显示桌面' : '恢复所有窗口'"
            :title="visibleIds.length ? '显示桌面' : '恢复所有窗口'"
            @click="toggleDesktop"
          >
            <PanelsTopLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="操作与快捷键"
            title="操作与快捷键"
            @click="shortcutsOpen = true"
          >
            <Keyboard />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="设置"
            title="设置"
            @click="settingsOpen = true"
          >
            <Settings />
          </Button>
        </div>
      </div>
    </footer>
    <AppLauncher
      v-model:open="launcherOpen"
      :apps="apps"
      :loading="loadingApps"
      :error="appsError"
      :connected="connected"
      :starting="starting"
      :can-files="supportsFiles"
      @launch="launch"
      @mirror="mirror"
      @refresh="loadApps"
      @connect="openDevice"
      @create="openNewWindow"
      @files="openFiles"
    />
    <DeviceDialog
      v-model:open="connectOpen"
      :devices="devices"
      :serial="serial"
      :loading="loadingDevices"
      :transport="transport"
      :usb-connected="!!webUsb"
      :usb-busy="usbBusy"
      :switching-transport="switchingTransport"
      :usb-status="usbStatus"
      :usb-error="usbError"
      :adb-windows-open="adbWindowsOpen"
      :adb-allowed="adbAllowed"
      @refresh="refreshDevices"
      @select="selectDevice"
      @webusb="selectWebUsb"
      @transport="chooseTransport"
      @cancel-usb="cancelUsb"
      @disconnect-usb="disconnectWebUsb"
    />
    <NewWindowDialog v-model:open="newWindowOpen" :apps="apps" @create="startWindow" />
    <SettingsDialog v-model:open="settingsOpen" />
    <WallpaperDialog
      v-model:open="wallpaperOpen"
      v-model:brightness="brightness"
      v-model:contrast="contrast"
      :wallpaper-url="wallpaperUrl"
      :wallpaper-name="wallpaperName"
      :loading="wallpaperLoading"
      @select="chooseWallpaper"
      @reset="restoreWallpaper"
    />
    <Dialog v-model:open="shortcutsOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>快捷键</DialogTitle>
        </DialogHeader>
        <dl class="shortcut-list">
          <div>
            <dt>搜索与打开应用</dt>
            <dd><kbd>⌘ / Ctrl K</kbd></dd>
          </div>
          <div>
            <dt>最小化当前窗口</dt>
            <dd><kbd>⌘ / Ctrl ⇧ M</kbd></dd>
          </div>
          <div>
            <dt>选择 / 打开搜索结果</dt>
            <dd><kbd>方向键 / Enter</kbd></dd>
          </div>
          <div>
            <dt>关闭启动器或对话框</dt>
            <dd><kbd>Esc</kbd></dd>
          </div>
          <div>
            <dt>放大 / 还原窗口</dt>
            <dd>双击标题栏</dd>
          </div>
          <div>
            <dt>恢复最小化的窗口</dt>
            <dd>点击 Dock 图标</dd>
          </div>
        </dl>
      </DialogContent>
    </Dialog>
    <Dialog
      :open="unlockOpen"
      @update:open="
        (value) => {
          if (!value) cancelStart()
        }
      "
    >
      <DialogContent>
        <DialogHeader>
          <div class="unlock-symbol"><LockKeyhole class="size-7" /></div>
          <DialogTitle>请先解锁手机</DialogTitle>
          <DialogDescription>{{ unlockMessage }}</DialogDescription>
        </DialogHeader>
        <div class="flex items-center gap-3 py-5 text-sm text-muted-foreground" role="status">
          <LoaderCircle class="size-4 animate-spin" />
          等待 {{ deviceName }} 解锁…
        </div>
        <Button variant="outline" @click="cancelStart">取消投屏</Button>
      </DialogContent>
    </Dialog>
  </div>
  <Teleport to="body">
    <Toaster :theme="theme" position="bottom-right" :close-button="true" rich-colors />
  </Teleport>
</template>
