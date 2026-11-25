<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, nextTick } from 'vue'
import {
  ChevronLeft,
  Circle,
  Square,
  LockKeyhole,
  MonitorOff,
  Ellipsis,
  Sun,
  Copy,
  RotateCw,
  RotateCcw,
  Maximize2,
  Upload,
  LoaderCircle,
  Volume2,
  VolumeX,
  Camera,
} from '@lucide/vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Session } from '@/lib/scrcpy/session.js'
import {
  WebUsbSession,
  type WebUsbSessionHooks,
  ControlEncoder,
  navBack,
  navHome,
  navRecents,
} from '@mugi/web-adb/scrcpy'
import { useScreenOff } from '@/composables/useScreenOff'
import { api, errorText } from '@/services/api'
import { uploadFiles } from '@/services/files'
import { downloadBlob } from '@/services/workbench'
import WindowFrame from './WindowFrame.vue'
import ConfirmOperation from './ConfirmOperation.vue'
import type { DesktopWindow, SessionInfo } from '@/types'
import { getActiveWebUsbConnection } from '@/services/webusb'
const props = defineProps<{
  window: DesktopWindow
  audioOccupied: boolean
}>()
const emit = defineEmits<{
  close: [id: string]
  sessionChange: [id: string, info: SessionInfo]
}>()
const frame = ref<InstanceType<typeof WindowFrame>>(),
  canvas = ref<HTMLCanvasElement>()
const fullscreenTarget = ref<HTMLElement>()
function syncFullscreenTarget() {
  fullscreenTarget.value = (document.fullscreenElement as HTMLElement | null) || undefined
}
const info = props.window.info
const id = props.window.id
const { screenOff } = useScreenOff()
let currentInfo = info
const clipboardToastId = `clipboard-${info.id}`
const appPackage = info.opts.mode === 'display' ? info.opts.startApp : ''
const restartOpen = ref(false)
const ratio = ref(info.opts.width && info.opts.height ? info.opts.width / info.opts.height : 9 / 16)
function updateRatio(width: number, height: number) {
  if (width > 0 && height > 0 && Math.abs(width / height - ratio.value) >= 0.0001)
    ratio.value = width / height
}
const ready = ref(false),
  closing = ref(false),
  connecting = ref(true),
  reconnecting = ref(false),
  switchingAudio = ref(false),
  powerBusy = ref(false),
  audio = ref(!!info.audioCodec),
  title = ref(props.window.app?.name || info.deviceName || 'Android')
const draggingFile = ref(0),
  progress = ref('')
type MirrorSession = Pick<
  Session,
  'start' | 'close' | 'detach' | 'send' | 'setDisplayPower' | 'wakeScreen' | 'lockScreen'
>
let session: MirrorSession | undefined,
  powerInitialized = false,
  disposed = false,
  stopRequested = false,
  generation = 0,
  stoppedId = ''
let stopping: Promise<void> | undefined
function send(message: Uint8Array) {
  return session?.send(message) || false
}
function restartApp() {
  if (
    !appPackage ||
    !ready.value ||
    connecting.value ||
    reconnecting.value ||
    switchingAudio.value ||
    closing.value
  )
    return
  try {
    if (!send(ControlEncoder.restartApp(appPackage))) {
      toast.error('无法重新启动应用，请等待投屏连接完成后重试')
      return
    }
    toast.info('已请求在当前投屏中重新启动应用')
  } catch (error) {
    toast.error(errorText(error))
  }
}
function autoScreenOff() {
  if (ready.value && screenOff.value && !powerInitialized)
    powerInitialized = session?.setDisplayPower(false) || false
}
function wakeScreen(notify = true) {
  const success = session?.wakeScreen() ?? false
  if (!success && notify) toast.error('无法唤醒屏幕，请等待投屏连接完成后重试')
  return success
}
function turnScreenOff(notify = true) {
  const success = session?.setDisplayPower(false) ?? false
  if (!success && notify) toast.error('无法熄灭屏幕，请等待投屏连接完成后重试')
  return success
}
async function lockScreen(notify = true) {
  if (!session || powerBusy.value) return false
  powerBusy.value = true
  try {
    const success = await session.lockScreen()
    if (!success && notify && !disposed && !closing.value)
      toast.error('无法锁屏，请等待投屏连接完成后重试')
    return success
  } finally {
    if (!disposed) powerBusy.value = false
  }
}
defineExpose({
  id,
  focus: focusCanvas,
  wakeScreen,
  turnScreenOff,
  lockScreen,
  scanFile(target: string, path: string) {
    return info.serial === target && send(ControlEncoder.scanFile(path))
  },
})
function stopSession(): Promise<void> {
  if (stoppedId === currentInfo.id) return stopping!
  const previous = session
  const target = currentInfo
  session = undefined
  stoppedId = target.id
  ++generation
  stopping = (async () => {
    try {
      if (target.transport !== 'webusb') await api.stopSession(target.id)
    } finally {
      await previous?.close('session stopped')
    }
  })()
  return stopping
}
async function close() {
  if (stopRequested) return
  stopRequested = true
  closing.value = true
  try {
    await stopSession()
  } catch (error) {
    toast.error(`结束投屏：${errorText(error)}`)
  } finally {
    emit('close', id)
  }
}
async function toggleAudio() {
  if (connecting.value || switchingAudio.value || closing.value || disposed) return
  const enabled = !audio.value
  if (enabled && props.audioOccupied) {
    toast.info('另一窗口已占用音频转发，请先关闭该窗口的音频')
    return
  }
  switchingAudio.value = true
  ready.value = false
  connecting.value = true
  try {
    // scrcpy's audio capture is a startup option. Fully release the old
    // capture before reconnecting, while retaining the WindowFrame identity.
    await stopSession()
    if (disposed || stopRequested) return
    // Keep Android's size and density independent of the desktop window.
    // Shrinking only the pixel dimensions makes the app's dp viewport too narrow.
    const opts = { ...currentInfo.opts, audio: enabled }
    const next: SessionInfo =
      info.transport === 'webusb'
        ? {
            ...currentInfo,
            id: `webusb-${crypto.randomUUID()}`,
            opts,
            audioCodec: enabled ? 'opus' : undefined,
          }
        : await api.startSession(info.serial, opts)
    // A window may be closed or its device disconnected while creation is pending.
    if (disposed || stopRequested) {
      if (next.transport !== 'webusb') await api.stopSession(next.id)
      return
    }
    currentInfo = next
    emit('sessionChange', id, next)
    audio.value = !!next.audioCodec
    powerInitialized = false
    if (next.warning) toast(next.warning)
    connectSession()
  } catch (error) {
    if (!disposed && !stopRequested) {
      toast.error(`切换音频失败：${errorText(error)}`)
      void close()
    }
  } finally {
    switchingAudio.value = false
  }
}
async function fullscreen() {
  try {
    await frame.value?.fullscreen()
  } catch (error) {
    toast.error(errorText(error))
  }
}
async function drop(event: DragEvent) {
  draggingFile.value = 0
  if (progress.value) return
  await uploadFiles(
    info.serial,
    '/sdcard/Download',
    Array.from(event.dataTransfer?.files || []),
    (label) => {
      progress.value = label
    },
    (path) => send(ControlEncoder.scanFile(path)),
  )
}
function focusCanvas() {
  canvas.value?.focus({ preventScroll: true })
}
function captureWindow() {
  if (!ready.value || !canvas.value) return
  canvas.value.toBlob((blob) => {
    if (blob) downloadBlob(blob, `mugi-window-${Date.now()}.png`)
    else toast.error('无法保存当前画面，请重试')
  }, 'image/png')
}
const onPageHide = () => {
  // WebUSB sessions die with the page; Go-backed sessions stay alive on the
  // server, so only release local resources and let a reload re-attach.
  if (info.transport === 'webusb') void close()
  else session?.detach()
}
onMounted(async () => {
  await nextTick()
  if (disposed || !canvas.value) return
  if (!('VideoDecoder' in window)) {
    toast.error('当前浏览器不支持视频解码，请使用新版 Chrome 或 Edge')
    void close()
    return
  }
  connectSession()
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('fullscreenchange', syncFullscreenTarget)
})
function connectSession() {
  if (!canvas.value || disposed || stopRequested) return
  const version = ++generation
  const active =
    <Args extends unknown[]>(callback: (...args: Args) => void) =>
    (...args: Args) => {
      if (version === generation && !disposed && !stopRequested) callback(...args)
    }
  const hooks: WebUsbSessionHooks = {
    onDeviceName: active((name) => {
      if (!props.window.app) title.value = name
    }),
    onFirstFrame: active(() => {
      ready.value = true
      autoScreenOff()
    }),
    onControlReady: active(() => {
      connecting.value = false
      autoScreenOff()
    }),
    onResize: active(updateRatio),
    onClipboard: active(async (text) => {
      try {
        await navigator.clipboard.writeText(text)
        toast.success('已复制手机剪贴板', { id: clipboardToastId })
      } catch {
        toast.error('请允许浏览器写入剪贴板后重试', { id: clipboardToastId })
      }
    }),
    onError: active((error) => toast.error(`投屏失败：${errorText(error)}`)),
    onReconnecting: active((value) => {
      reconnecting.value = value
    }),
    onAudioEnd: active(() => {
      audio.value = false
    }),
    onAudioUnavailable: active(() => {
      currentInfo = {
        ...currentInfo,
        opts: { ...currentInfo.opts, audio: false },
        audioCodec: undefined,
      }
      emit('sessionChange', id, currentInfo)
      toast.info('另一窗口已占用音频转发，请先关闭该窗口的音频')
    }),
    onClose: active(() => {
      if (!disposed && !stopRequested) void close()
    }),
  }
  if (info.transport === 'webusb') {
    const connection = getActiveWebUsbConnection(info.serial)
    if (!connection) {
      toast.error('WebUSB 设备连接已失效，请重新连接')
      void close()
      return
    }
    session = new WebUsbSession(connection, currentInfo, canvas.value, hooks)
  } else {
    session = new Session(currentInfo, canvas.value, hooks)
  }
  session.start()
}
onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('pagehide', onPageHide)
  document.removeEventListener('fullscreenchange', syncFullscreenTarget)
  stopRequested = true
  void stopSession().catch(() => {})
})
</script>
<template>
  <WindowFrame
    :id="id"
    ref="frame"
    class="mirror-window"
    :title="title"
    :control-label="` ${title} 窗口`"
    zoom-label="放大"
    titlebar-class="mirror-titlebar"
    resize-class="mirror-resize-handle"
    resize-label="等比调整窗口"
    focus-selector="canvas"
    :closing="closing"
    :active-layer="2"
    :geometry="{ aspectRatio: ratio, titlebarHeight: 36, chrome: { width: 0, height: 72 } }"
    :style="{ '--video-ratio': String(ratio) }"
    :data-session-id="window.info.id"
    :aria-label="`${title} 投屏窗口`"
    @close="close"
  >
    <div
      class="mirror-screen"
      @dragenter.prevent="draggingFile++"
      @dragover.prevent
      @dragleave.prevent="draggingFile = Math.max(0, draggingFile - 1)"
      @drop.prevent="drop"
    >
      <canvas
        ref="canvas"
        tabindex="0"
        :aria-label="`${title} 的触控画面`"
        @pointerdown="focusCanvas"
      />
      <div v-if="!ready || reconnecting" class="screen-message">
        <LoaderCircle class="size-6 animate-spin" />
        <span>
          {{
            reconnecting
              ? '连接中断，正在重连…'
              : closing
                ? '正在结束投屏…'
                : switchingAudio
                  ? '正在切换音频…'
                  : '正在连接设备…'
          }}
        </span>
      </div>
      <div v-if="draggingFile || progress" class="screen-message drop-message">
        <Upload class="size-7" />
        <span>{{ progress || '松开以发送到手机' }}</span>
      </div>
    </div>
    <footer class="mirror-toolbar">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="返回"
        title="返回"
        :disabled="!ready"
        @click="navBack(send)"
      >
        <ChevronLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="主屏幕"
        title="主屏幕"
        :disabled="!ready"
        @click="navHome(send)"
      >
        <Circle />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="最近任务"
        title="最近任务"
        :disabled="!ready"
        @click="navRecents(send)"
      >
        <Square />
      </Button>
      <span class="flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-xs" aria-label="更多操作" title="更多操作">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" class="w-48" :portal-to="fullscreenTarget">
          <DropdownMenuGroup>
            <DropdownMenuItem
              :class="{ 'text-primary': audio }"
              :aria-label="audio ? '关闭音频转发' : '开启音频转发'"
              :title="`${audio ? '关闭' : '开启'}音频转发（会短暂重连投屏）`"
              :disabled="connecting || switchingAudio || closing"
              @select="toggleAudio"
            >
              <LoaderCircle v-if="switchingAudio" class="animate-spin" />
              <Volume2 v-else-if="audio" aria-label="音频已开启" />
              <VolumeX v-else />
              {{ audio ? '关闭音频转发' : '开启音频转发' }}
            </DropdownMenuItem>
            <DropdownMenuItem :disabled="!ready" @select="captureWindow">
              <Camera />
              保存窗口截图
            </DropdownMenuItem>
            <DropdownMenuItem
              v-if="appPackage"
              :disabled="!ready || connecting || reconnecting || switchingAudio || closing"
              @select="restartOpen = true"
            >
              <RotateCcw />
              重新启动应用
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>屏幕操作</DropdownMenuLabel>
          <DropdownMenuGroup>
            <DropdownMenuItem :disabled="connecting || powerBusy" @select="wakeScreen()">
              <Sun />
              唤醒屏幕
            </DropdownMenuItem>
            <DropdownMenuItem :disabled="connecting || powerBusy" @select="turnScreenOff()">
              <MonitorOff />
              熄灭屏幕
            </DropdownMenuItem>
            <DropdownMenuItem :disabled="connecting || powerBusy" @select="lockScreen()">
              <LockKeyhole />
              锁屏
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem :disabled="!ready" @select="send(ControlEncoder.getClipboard())">
              <Copy />
              从手机复制
            </DropdownMenuItem>
            <DropdownMenuItem :disabled="!ready" @select="send(ControlEncoder.rotateDevice())">
              <RotateCw />
              旋转设备
            </DropdownMenuItem>
            <DropdownMenuItem @select="fullscreen">
              <Maximize2 />
              全屏
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </footer>
    <ConfirmOperation
      v-model:open="restartOpen"
      title="重新启动应用"
      description="将停止并在当前投屏中重新打开此应用，以尝试恢复异常布局。未保存的内容可能丢失。"
      :portal-to="fullscreenTarget"
      @confirm="restartApp"
    />
  </WindowFrame>
</template>
