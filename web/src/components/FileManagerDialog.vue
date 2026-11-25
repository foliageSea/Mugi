<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, toRef, watch } from 'vue'
import {
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  FilePlus2,
  Film,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  HardDrive,
  Eye,
  Image,
  Info,
  List,
  LoaderCircle,
  Music,
  Pencil,
  RefreshCw,
  Search,
  Scissors,
  Trash2,
  Upload,
} from '@lucide/vue'
import type Viewer from 'viewerjs'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useFileManager } from '@/composables/useFileManager'
import type { TransferTask } from '@/composables/useFileManager'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import WindowFrame from './WindowFrame.vue'
import { api, errorText } from '@/services/api'
import { isWebUsbSerial } from '@/services/webusb-helpers'
import { formatBytes, remoteFileKind, remotePathJoin } from '@/services/files'
import type { RemoteFile } from '@/types'
import RemoteFileIcon from './RemoteFileIcon.vue'

const VideoPreviewDialog = defineAsyncComponent(() => import('./VideoPreviewDialog.vue'))

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ serial: string }>()
const emit = defineEmits<{ uploaded: [serial: string, path: string] }>()
const manager = useFileManager(toRef(props, 'serial'))
const picker = ref<HTMLInputElement>()
const nameInput = ref<HTMLInputElement>()
const namingOpen = ref(false)
const namingMode = ref<'create' | 'rename'>('create')
const pendingName = ref('')
const deleteOpen = ref(false)
const deleteTargets = ref<RemoteFile[]>([])
const propertiesOpen = ref(false)
const propertyTarget = ref<RemoteFile | null>(null)
const imagePreviewOpen = ref(false)
const videoOpen = ref(false)
const videoTarget = ref<RemoteFile | null>(null)
const contextMenu = ref<{ file: RemoteFile | null; x: number; y: number } | null>(null)
const dragDepth = ref(0)
const dragging = computed(() => dragDepth.value > 0)
const selectionBox = ref<{ left: number; top: number; width: number; height: number } | null>(null)
let marquee:
  | {
      browser: HTMLElement
      pointerId: number
      startX: number
      startY: number
      base: Set<string>
      toggle: boolean
      additive: boolean
      moved: boolean
    }
  | undefined
const selectedPreviewable = computed(() => {
  if (
    manager.selectedFiles.value.length !== 1 ||
    !manager.selected.value ||
    manager.selected.value.isDir
  )
    return false
  return ['image', 'video'].includes(remoteFileKind(manager.selected.value.name))
})
const singleSelected = computed(() =>
  manager.selectedFiles.value.length === 1 ? manager.selected.value : null,
)
let imageViewer: Viewer | undefined
const usb = computed(() => isWebUsbSerial(props.serial))
const readingFile = ref(false)
let mediaController: AbortController | undefined
const mediaURLs = new Set<string>()
function clearMedia() {
  mediaController?.abort()
  mediaController = undefined
  imageViewer?.destroy()
  imageViewer = undefined
  imagePreviewOpen.value = false
  videoOpen.value = false
  for (const url of mediaURLs) URL.revokeObjectURL(url)
  mediaURLs.clear()
}

const locations = [
  { label: '下载', path: '/sdcard/Download', icon: ArrowDownToLine },
  { label: '文档', path: '/sdcard/Documents', icon: FilePlus2 },
  { label: '图片', path: '/sdcard/Pictures', icon: Image },
  { label: '音乐', path: '/sdcard/Music', icon: Music },
  { label: '影片', path: '/sdcard/Movies', icon: Film },
  { label: '相机', path: '/sdcard/DCIM', icon: FolderOpen },
]

const nameError = computed(() => {
  const value = pendingName.value.trim()
  if (!value) return '请输入名称'
  if (value === '.' || value === '..' || /[/\r\n]/.test(value)) return '名称不能包含路径字符'
  if (namingMode.value === 'rename' && value === manager.selected.value?.name)
    return '请输入不同的名称'
  const duplicate = manager.files.value.some(
    (file) =>
      file.name.localeCompare(value, undefined, { sensitivity: 'base' }) === 0 &&
      (namingMode.value === 'create' || file.name !== manager.selected.value?.name),
  )
  return duplicate ? '当前文件夹中已存在同名项目' : ''
})

watch(open, (visible) => {
  if (visible && props.serial) {
    manager.reset()
    void manager.load()
  } else {
    clearMedia()
    contextMenu.value = null
    namingOpen.value = false
    deleteOpen.value = false
    propertiesOpen.value = false
    videoOpen.value = false
  }
})

onBeforeUnmount(() => {
  clearMedia()
  marquee = undefined
})
watch(
  () => props.serial,
  () => {
    clearMedia()
    contextMenu.value = null
    manager.reset()
    if (open.value && props.serial) void manager.load()
  },
)
watch(manager.currentPath, () => {
  contextMenu.value = null
})
watch(namingOpen, async (visible) => {
  if (!visible) return
  await nextTick()
  nameInput.value?.focus()
  nameInput.value?.select()
})

function startNaming(mode: 'create' | 'rename') {
  if (mode === 'rename' && !manager.selected.value) return
  namingMode.value = mode
  pendingName.value = mode === 'rename' ? manager.selected.value?.name || '' : '未命名文件夹'
  namingOpen.value = true
}

async function submitName() {
  if (nameError.value || manager.operating.value) return
  const value = pendingName.value.trim()
  const success =
    namingMode.value === 'create'
      ? await manager.createFolder(value)
      : await manager.renameSelected(value)
  if (success) namingOpen.value = false
}

async function confirmDelete() {
  if (await manager.deleteSelected(deleteTargets.value.map((file) => file.name)))
    deleteOpen.value = false
}

function requestDelete() {
  if (!manager.selectedFiles.value.length) return
  deleteTargets.value = [...manager.selectedFiles.value]
  deleteOpen.value = true
  closeContextMenu()
}

function stageTransfer(mode: 'copy' | 'move') {
  manager.stageTransfer(mode)
  closeContextMenu()
}

function showProperties(file: RemoteFile) {
  propertyTarget.value = file
  propertiesOpen.value = true
  closeContextMenu()
}

const propertyPath = computed(() =>
  propertyTarget.value ? remotePathJoin(manager.currentPath.value, propertyTarget.value.name) : '',
)
const propertyType = computed(() => {
  if (!propertyTarget.value) return ''
  const kind = remoteFileKind(propertyTarget.value.name, propertyTarget.value.isDir)
  return (
    {
      folder: '文件夹',
      image: '图片',
      video: '视频',
      audio: '音频',
      archive: '压缩文件',
      apk: 'Android 应用安装包',
      document: '文档',
      file: '文件',
    } as const
  )[kind]
})

async function copyPath(file = propertyTarget.value) {
  if (!file) return
  const value = remotePathJoin(manager.currentPath.value, file.name)
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    const input = document.createElement('textarea')
    input.value = value
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.append(input)
    input.select()
    document.execCommand('copy')
    input.remove()
  }
  toast.success('文件路径已复制')
  closeContextMenu()
}

async function upload(list: File[]) {
  dragDepth.value = 0
  const target = props.serial
  await manager.upload(list, (path) => emit('uploaded', target, path))
  if (picker.value) picker.value.value = ''
}

function download(file: RemoteFile) {
  void manager.download(file)
}

async function preview(file: RemoteFile) {
  const kind = remoteFileKind(file.name, file.isDir)
  if (kind === 'image') {
    if (readingFile.value) return
    const target = props.serial
    const path = manager.currentPath.value
    mediaController?.abort()
    const controller = new AbortController()
    mediaController = controller
    readingFile.value = true
    try {
      const [{ api: viewerApi }] = await Promise.all([
        import('v-viewer'),
        import('viewerjs/dist/viewer.css'),
      ])
      if (!open.value || controller.signal.aborted) return
      const imageFiles = manager.visibleFiles.value.filter(
        (candidate) => remoteFileKind(candidate.name, candidate.isDir) === 'image',
      )
      const images = await Promise.all(
        (isWebUsbSerial(target) ? [file] : imageFiles).map(async (candidate) => ({
          src: await api.fileUrl(target, remotePathJoin(path, candidate.name), controller.signal),
          alt: candidate.name,
        })),
      )
      const blobs = images.map((image) => image.src).filter((url) => url.startsWith('blob:'))
      if (controller.signal.aborted) {
        blobs.forEach((url) => URL.revokeObjectURL(url))
        return
      }
      blobs.forEach((url) => mediaURLs.add(url))
      imagePreviewOpen.value = true
      imageViewer = viewerApi({
        images,
        options: {
          initialViewIndex: Math.max(
            0,
            images.findIndex((candidate) => candidate.alt === file.name),
          ),
          navbar: images.length > 1,
          title: (image) => image.alt,
          toolbar: true,
          transition: true,
          hidden: () => {
            queueMicrotask(() => {
              imagePreviewOpen.value = false
              imageViewer = undefined
              blobs.forEach((url) => {
                URL.revokeObjectURL(url)
                mediaURLs.delete(url)
              })
            })
          },
        },
      })
    } catch (cause) {
      if (!controller.signal.aborted) toast.error(`预览失败：${errorText(cause)}`)
    } finally {
      readingFile.value = false
    }
    return
  }
  if (kind === 'video') {
    videoTarget.value = file
    videoOpen.value = true
  }
}

function activate(file: RemoteFile) {
  contextMenu.value = null
  if (file.isDir) void manager.navigate(remotePathJoin(manager.currentPath.value, file.name))
  else if (['image', 'video'].includes(remoteFileKind(file.name))) void preview(file)
}

function openContextMenu(event: MouseEvent, file: RemoteFile) {
  if (!manager.selectedNames.value.has(file.name)) manager.selectOnly(file.name)
  else manager.selectedName.value = file.name
  openPositionedContextMenu(event, file)
}

function openPositionedContextMenu(event: MouseEvent, file: RemoteFile | null) {
  const browser = (event.currentTarget as HTMLElement).closest(
    '.file-browser',
  ) as HTMLElement | null
  if (!browser) return
  const bounds = browser.getBoundingClientRect()
  const x = event.clientX - bounds.left + browser.scrollLeft
  const y = event.clientY - bounds.top + browser.scrollTop
  contextMenu.value = {
    file,
    x: Math.max(
      browser.scrollLeft + 4,
      Math.min(x, browser.scrollLeft + browser.clientWidth - 178),
    ),
    y: Math.max(browser.scrollTop + 4, Math.min(y, browser.scrollTop + browser.clientHeight - 286)),
  }
}

function openBlankContextMenu(event: MouseEvent) {
  manager.clearSelection()
  openPositionedContextMenu(event, null)
}

function closeContextMenu() {
  contextMenu.value = null
}

function taskPercent(task: TransferTask) {
  if (!task.total) return 0
  return Math.min(100, Math.round((task.loaded / task.total) * 100))
}

function taskSize(task: TransferTask) {
  if (!task.total) return task.phase
  return `${formatBytes(task.loaded)} / ${formatBytes(task.total)}`
}

function taskStatus(task: TransferTask) {
  if (task.status === 'completed') return '已完成'
  if (task.status === 'failed') return task.error || '失败'
  return task.phase || (task.direction === 'upload' ? '上传中' : '下载中')
}

function pasteFromContextMenu() {
  closeContextMenu()
  void manager.paste()
}

function createFolderFromContextMenu() {
  closeContextMenu()
  startNaming('create')
}

function downloadFromContextMenu() {
  const file = contextMenu.value?.file
  closeContextMenu()
  if (file) void download(file)
}

function rename(file: RemoteFile) {
  manager.selectOnly(file.name)
  startNaming('rename')
}

function dragFile(event: DragEvent, file: RemoteFile) {
  if (usb.value || file.isDir || !event.dataTransfer) return
  const url = new URL(
    api.pullUrl(props.serial, remotePathJoin(manager.currentPath.value, file.name)),
    location.href,
  ).href
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData('DownloadURL', `application/octet-stream:${file.name}:${url}`)
  event.dataTransfer.setData('text/uri-list', url)
}

function dragEnter(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return
  dragDepth.value++
}

function dragLeave() {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}

function browserPoint(event: PointerEvent, browser: HTMLElement) {
  const bounds = browser.getBoundingClientRect()
  return {
    x: event.clientX - bounds.left + browser.scrollLeft,
    y: event.clientY - bounds.top + browser.scrollTop,
  }
}

function startMarquee(event: PointerEvent) {
  if (
    event.button !== 0 ||
    event.pointerType === 'touch' ||
    manager.loading.value ||
    !(event.currentTarget instanceof HTMLElement) ||
    (event.target instanceof Element &&
      event.target.closest('.file-item, button, input, [role="menu"]'))
  )
    return
  event.preventDefault()
  const browser = event.currentTarget
  const point = browserPoint(event, browser)
  marquee = {
    browser,
    pointerId: event.pointerId,
    startX: point.x,
    startY: point.y,
    base: new Set(manager.selectedNames.value),
    toggle: event.metaKey || event.ctrlKey,
    additive: event.shiftKey,
    moved: false,
  }
  selectionBox.value = null
  closeContextMenu()
  browser.setPointerCapture(event.pointerId)
}

function moveMarquee(event: PointerEvent) {
  if (!marquee || event.pointerId !== marquee.pointerId) return
  event.preventDefault()
  const point = browserPoint(event, marquee.browser)
  if (!marquee.moved && Math.hypot(point.x - marquee.startX, point.y - marquee.startY) < 4) return
  marquee.moved = true
  const left = Math.min(marquee.startX, point.x)
  const top = Math.min(marquee.startY, point.y)
  const right = Math.max(marquee.startX, point.x)
  const bottom = Math.max(marquee.startY, point.y)
  selectionBox.value = { left, top, width: right - left, height: bottom - top }

  const browserBounds = marquee.browser.getBoundingClientRect()
  const hits: string[] = []
  for (const item of marquee.browser.querySelectorAll<HTMLElement>('.file-item[data-file-name]')) {
    const bounds = item.getBoundingClientRect()
    const itemLeft = bounds.left - browserBounds.left + marquee.browser.scrollLeft
    const itemTop = bounds.top - browserBounds.top + marquee.browser.scrollTop
    if (
      itemLeft < right &&
      itemLeft + bounds.width > left &&
      itemTop < bottom &&
      itemTop + bounds.height > top
    )
      hits.push(item.dataset.fileName || '')
  }
  const selected = marquee.additive || marquee.toggle ? new Set(marquee.base) : new Set<string>()
  for (const name of hits) {
    if (marquee.toggle && selected.has(name)) selected.delete(name)
    else selected.add(name)
  }
  manager.setSelection(selected, hits.at(-1) || selected.values().next().value || '')
}

function finishMarquee(event: PointerEvent) {
  if (!marquee || event.pointerId !== marquee.pointerId) return
  if (!marquee.moved && !marquee.toggle && !marquee.additive) manager.clearSelection()
  if (marquee.browser.hasPointerCapture(event.pointerId))
    marquee.browser.releasePointerCapture(event.pointerId)
  marquee = undefined
  selectionBox.value = null
}

function keyboard(event: KeyboardEvent) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return
  const command = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()
  if (command && key === 'a') {
    event.preventDefault()
    manager.selectAll()
  } else if (command && key === 'c' && manager.selectedFiles.value.length) {
    event.preventDefault()
    manager.stageTransfer('copy')
  } else if (command && key === 'x' && manager.selectedFiles.value.length) {
    event.preventDefault()
    manager.stageTransfer('move')
  } else if (command && key === 'v' && manager.canPaste.value) {
    event.preventDefault()
    void manager.paste()
  } else if (event.key === 'Backspace') {
    event.preventDefault()
    void manager.up()
  } else if (event.key === 'Enter' && manager.selected.value) {
    activate(manager.selected.value)
  } else if (event.key === 'F2' && singleSelected.value) {
    event.preventDefault()
    startNaming('rename')
  } else if (event.key === 'Delete' && manager.selected.value) {
    requestDelete()
  }
}
</script>

<template>
  <!-- prettier-ignore -->
  <Transition name="window-motion" appear>
  <WindowFrame
    v-if="open"
    id="file-manager"
    title="文件管理器"
    control-label="文件管理器"
    class="file-manager-dialog"
    layout-class="file-manager-shell"
    titlebar-class="file-manager-toolbar"
    resize-class="file-resize-handle"
    resize-label="调节文件管理器窗口大小"
    :geometry="{
      size: { width: 1180, height: 760 },
      minSize: { width: 700, height: 480 },
      margin: 24,
      titlebarHeight: 56,
      mobileFullscreen: true,
    }"
    data-testid="file-manager-window"
    role="dialog"
    aria-describedby="file-manager-description"
    :close-on-escape="
      !imagePreviewOpen && !namingOpen && !deleteOpen && !propertiesOpen && !videoOpen
    "
    @close="open = false"
    @keydown="keyboard"
  >
    <h2 class="sr-only">文件管理器</h2>
    <p id="file-manager-description" class="sr-only">浏览和管理 Android 手机内部存储中的文件。</p>
    <template #titlebar>
      <div class="file-nav-buttons">
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="!manager.canBack.value"
          aria-label="后退"
          @click="manager.back"
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="!manager.canForward.value"
          aria-label="前进"
          @click="manager.forward"
        >
          <ChevronRight />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="!manager.canGoUp.value"
          aria-label="返回上一级"
          @click="manager.up"
        >
          <ChevronUp />
        </Button>
      </div>
      <div class="file-toolbar-actions">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="新建文件夹"
          title="新建文件夹"
          @click="startNaming('create')"
        >
          <FolderPlus />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="manager.hasActiveTransfer.value || !!manager.progress.value"
          aria-label="上传"
          title="上传"
          @click="picker?.click()"
        >
          <Upload />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button
              variant="ghost"
              size="icon-sm"
              class="file-transfer-trigger"
              aria-label="查看传输任务"
              title="传输任务"
            >
              <List />
              <span v-if="manager.activeTransferCount.value" class="file-transfer-badge">
                {{ manager.activeTransferCount.value }}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="file-transfer-popover">
            <div class="file-transfer-header">
              <strong>传输任务</strong>
              <span>{{ manager.tasks.value.length }} 个任务</span>
            </div>
            <div v-if="!manager.tasks.value.length" class="file-transfer-empty">
              暂无传输任务
            </div>
            <div v-else class="file-transfer-list">
              <div
                v-for="task in manager.tasks.value"
                :key="task.id"
                class="file-transfer-task"
                :class="`is-${task.status}`"
              >
                <div class="file-transfer-task-title">
                  <Upload v-if="task.direction === 'upload'" />
                  <ArrowDownToLine v-else />
                  <span :title="task.currentName">{{ task.currentName }}</span>
                  <small v-if="task.count > 1">{{ task.index + 1 }}/{{ task.count }}</small>
                </div>
                <div v-if="task.status === 'running'" class="file-transfer-progress">
                  <span :style="{ width: `${taskPercent(task)}%` }" />
                </div>
                <div class="file-transfer-task-meta">
                  <span>{{ taskStatus(task) }}</span>
                  <span v-if="task.total">{{ taskPercent(task) }}% · {{ taskSize(task) }}</span>
                </div>
              </div>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="!manager.selectedFiles.value.length || manager.operating.value"
          aria-label="复制所选项目"
          title="复制 · ⌘ / Ctrl C"
          @click="stageTransfer('copy')"
        >
          <Copy />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="!manager.selectedFiles.value.length || manager.operating.value"
          aria-label="剪切所选项目"
          title="剪切 · ⌘ / Ctrl X"
          @click="stageTransfer('move')"
        >
          <Scissors />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="!manager.canPaste.value || manager.operating.value"
          aria-label="粘贴到当前文件夹"
          :title="manager.canPaste.value ? '粘贴 · ⌘ / Ctrl V' : '剪贴板为空或无法粘贴'"
          @click="manager.paste"
        >
          <ClipboardPaste />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="!selectedPreviewable"
          aria-label="预览所选媒体"
          @click="manager.selected.value && preview(manager.selected.value)"
        >
          <Eye />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="!singleSelected || manager.hasActiveTransfer.value || !!manager.progress.value"
          aria-label="下载所选文件"
          @click="singleSelected && download(singleSelected)"
        >
          <ArrowDownToLine />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="!singleSelected"
          aria-label="重命名所选项目"
          @click="startNaming('rename')"
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="!manager.selectedFiles.value.length"
          :aria-label="`删除所选项目${manager.selectedFiles.value.length > 1 ? `（${manager.selectedFiles.value.length} 个）` : ''}`"
          @click="requestDelete"
        >
          <Trash2 />
        </Button>
      </div>
    </template>

    <aside class="file-manager-sidebar" aria-label="常用位置">
      <p>位置</p>
      <nav>
        <button
          v-for="location in locations"
          :key="location.path"
          :class="{ active: manager.currentPath.value === location.path }"
          @click="manager.navigate(location.path)"
        >
          <component :is="location.icon" />
          <span>{{ location.label }}</span>
        </button>
      </nav>
      <div class="file-device-card">
        <HardDrive />
        <span>
          <strong>Android</strong>
          <small>共享存储空间</small>
        </span>
      </div>
    </aside>

    <main class="file-manager-main">
      <div class="file-manager-controls">
        <nav class="file-breadcrumbs" aria-label="当前文件路径">
          <template v-for="(crumb, index) in manager.breadcrumbs.value" :key="crumb.path">
            <ChevronRight v-if="index" aria-hidden="true" />
            <span v-if="index === 0" class="file-breadcrumb-root" aria-disabled="true">
              {{ crumb.label }}
            </span>
            <button
              v-else
              :aria-current="index === manager.breadcrumbs.value.length - 1 ? 'page' : undefined"
              @click="manager.navigate(crumb.path)"
            >
              {{ crumb.label }}
            </button>
          </template>
        </nav>
        <div class="file-control-actions">
          <label class="file-search">
            <Search />
            <Input v-model="manager.query.value" variant="search" placeholder="搜索当前文件夹" />
            <span class="sr-only">搜索当前文件夹</span>
          </label>
          <Select v-model="manager.sort.value">
            <SelectTrigger class="file-sort" aria-label="文件排序方式">
              <SelectValue placeholder="排序" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="name">名称</SelectItem>
                <SelectItem value="date">修改日期</SelectItem>
                <SelectItem value="size">大小</SelectItem>
                <SelectItem value="type">类型</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <ToggleGroup
            v-model="manager.view.value"
            type="single"
            variant="outline"
            size="sm"
            aria-label="文件显示方式"
          >
            <ToggleGroupItem value="icons" aria-label="图标视图"><Grid2X2 /></ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="列表视图"><List /></ToggleGroupItem>
          </ToggleGroup>
          <Button
            variant="ghost"
            size="icon-sm"
            :disabled="manager.loading.value"
            aria-label="刷新文件"
            @click="manager.load()"
          >
            <RefreshCw :class="{ 'animate-spin': manager.loading.value }" />
          </Button>
        </div>
      </div>

      <input
        ref="picker"
        type="file"
        multiple
        class="sr-only"
        aria-label="选择上传文件"
        :disabled="manager.hasActiveTransfer.value || !!manager.progress.value"
        @change="upload(Array.from(($event.target as HTMLInputElement).files || []))"
      />

      <section
        class="file-browser"
        :class="{ dragging, selecting: !!selectionBox }"
        aria-label="文件列表"
        @dragenter.prevent="dragEnter"
        @dragover.prevent
        @dragleave.prevent="dragLeave"
        @drop.prevent="upload(Array.from($event.dataTransfer?.files || []))"
        @click="closeContextMenu"
        @contextmenu.prevent="openBlankContextMenu"
        @pointerdown="startMarquee"
        @pointermove="moveMarquee"
        @pointerup="finishMarquee"
        @pointercancel="finishMarquee"
      >
        <div v-if="dragging" class="file-drop-overlay">
          <Upload />
          <strong>上传到 {{ manager.breadcrumbs.value.at(-1)?.label }}</strong>
          <span>松开即可传输，APK 文件将自动安装</span>
        </div>

        <div v-if="manager.loading.value" class="file-loading" aria-label="正在读取文件">
          <div v-for="index in 8" :key="index">
            <Skeleton class="size-16 rounded-xl" />
            <Skeleton class="h-3 w-20" />
          </div>
        </div>

        <Empty v-else-if="manager.error.value" class="file-browser-empty" role="alert">
          <EmptyHeader>
            <EmptyTitle>无法打开这个文件夹</EmptyTitle>
            <EmptyDescription>{{ manager.error.value }}</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" @click="manager.load()">重新读取</Button>
        </Empty>

        <Empty
          v-else-if="!manager.visibleFiles.value.length"
          class="file-browser-empty"
          :aria-label="manager.query.value ? '没有匹配的文件' : '这个文件夹是空的'"
        >
          <EmptyMedia variant="icon" class="mb-0">
            <Search v-if="manager.query.value" />
            <FolderOpen v-else />
          </EmptyMedia>
        </Empty>

        <template v-else>
          <div v-if="manager.view.value === 'list'" class="file-list-header" aria-hidden="true">
            <span>名称</span>
            <span>修改日期</span>
            <span>大小</span>
          </div>
          <div
            class="file-items"
            :data-view="manager.view.value"
            role="listbox"
            aria-label="当前文件夹"
          >
            <button
              v-for="file in manager.visibleFiles.value"
              :key="file.name"
              class="file-item"
              :data-file-name="file.name"
              :class="{ selected: manager.selectedNames.value.has(file.name) }"
              :draggable="!usb && !file.isDir"
              role="option"
              :aria-selected="manager.selectedNames.value.has(file.name)"
              :aria-label="`${file.isDir ? '文件夹' : '文件'} ${file.name}`"
              @click="
                manager.selectFile(file.name, $event.metaKey || $event.ctrlKey, $event.shiftKey)
              "
              @dblclick="activate(file)"
              @contextmenu.prevent.stop="openContextMenu($event, file)"
              @keydown.enter="activate(file)"
              @keydown.f2.prevent="rename(file)"
              @dragstart="dragFile($event, file)"
            >
              <RemoteFileIcon :name="file.name" :is-dir="file.isDir" />
              <span class="file-item-name">{{ file.name }}</span>
              <span class="file-item-date">
                {{ file.mtime ? new Date(file.mtime * 1000).toLocaleDateString() : '—' }}
              </span>
              <span class="file-item-size">
                {{ file.isDir ? '—' : formatBytes(file.size) }}
              </span>
            </button>
          </div>
        </template>

        <div
          v-if="selectionBox"
          class="file-selection-box"
          aria-hidden="true"
          :style="{
            left: `${selectionBox.left}px`,
            top: `${selectionBox.top}px`,
            width: `${selectionBox.width}px`,
            height: `${selectionBox.height}px`,
          }"
        />

        <div
          v-if="contextMenu"
          class="file-context-menu"
          role="menu"
          :aria-label="contextMenu.file ? '文件操作' : '文件夹操作'"
          :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
          @click.stop
        >
          <template v-if="contextMenu.file">
            <button
              v-if="contextMenu.file.isDir"
              type="button"
              role="menuitem"
              @click="activate(contextMenu.file)"
            >
              <FolderOpen />
              <span>打开</span>
            </button>
            <button v-else type="button" role="menuitem" @click="downloadFromContextMenu">
              <ArrowDownToLine />
              <span>下载</span>
            </button>
            <div class="file-context-separator" role="separator" />
            <button type="button" role="menuitem" @click="stageTransfer('copy')">
              <Copy />
              <span>
                复制{{
                  manager.selectedFiles.value.length > 1
                    ? `（${manager.selectedFiles.value.length} 项）`
                    : ''
                }}
              </span>
            </button>
            <button type="button" role="menuitem" @click="stageTransfer('move')">
              <Scissors />
              <span>
                剪切{{
                  manager.selectedFiles.value.length > 1
                    ? `（${manager.selectedFiles.value.length} 项）`
                    : ''
                }}
              </span>
            </button>
            <button
              v-if="manager.selectedFiles.value.length === 1"
              type="button"
              role="menuitem"
              @click="contextMenu.file && rename(contextMenu.file)"
            >
              <Pencil />
              <span>重命名</span>
            </button>
            <button type="button" role="menuitem" @click="requestDelete">
              <Trash2 />
              <span>
                删除{{
                  manager.selectedFiles.value.length > 1
                    ? `（${manager.selectedFiles.value.length} 项）`
                    : ''
                }}
              </span>
            </button>
            <div class="file-context-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              @click="contextMenu.file && copyPath(contextMenu.file)"
            >
              <ClipboardCopy />
              <span>复制文件路径</span>
            </button>
            <button
              type="button"
              role="menuitem"
              @click="contextMenu.file && showProperties(contextMenu.file)"
            >
              <Info />
              <span>属性</span>
            </button>
          </template>
          <template v-else>
            <button
              type="button"
              role="menuitem"
              :disabled="!manager.canPaste.value || manager.operating.value"
              :title="manager.canPaste.value ? '粘贴到当前文件夹' : '剪贴板为空或无法粘贴'"
              @click="pasteFromContextMenu"
            >
              <ClipboardPaste />
              <span>粘贴</span>
            </button>
            <button
              type="button"
              role="menuitem"
              :disabled="manager.operating.value"
              @click="createFolderFromContextMenu"
            >
              <FolderPlus />
              <span>新建文件夹</span>
            </button>
          </template>
        </div>
      </section>
    </main>

    <footer class="file-manager-status">
      <span>{{ manager.statusText.value }}</span>
    </footer>
  </WindowFrame>
  </Transition>

  <Dialog v-model:open="namingOpen">
    <DialogContent>
      <form class="flex flex-col gap-5" @submit.prevent="submitName">
        <DialogHeader>
          <DialogTitle>{{ namingMode === 'create' ? '新建文件夹' : '重命名项目' }}</DialogTitle>
          <DialogDescription>
            {{ namingMode === 'create' ? '文件夹将创建在当前目录中。' : '输入项目的新名称。' }}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field :data-invalid="!!nameError">
            <FieldLabel for="file-item-name">名称</FieldLabel>
            <Input
              id="file-item-name"
              ref="nameInput"
              v-model="pendingName"
              :aria-invalid="!!nameError"
            />
            <small v-if="nameError" class="text-destructive">{{ nameError }}</small>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" @click="namingOpen = false">取消</Button>
          <Button type="submit" :disabled="!!nameError || manager.operating.value">
            <LoaderCircle
              v-if="manager.operating.value"
              data-icon="inline-start"
              class="animate-spin"
            />
            {{ namingMode === 'create' ? '创建' : '保存' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="deleteOpen">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          {{
            deleteTargets.length === 1
              ? `删除“${deleteTargets[0]?.name}”？`
              : `删除 ${deleteTargets.length} 个项目？`
          }}
        </DialogTitle>
        <DialogDescription>
          所选{{
            deleteTargets.length === 1 ? '项目' : `${deleteTargets.length} 个项目`
          }}将从手机中永久删除，文件夹内的内容也会一并删除。此操作无法撤销。
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="deleteOpen = false">取消</Button>
        <Button variant="destructive" :disabled="manager.operating.value" @click="confirmDelete">
          <LoaderCircle
            v-if="manager.operating.value"
            data-icon="inline-start"
            class="animate-spin"
          />
          删除
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="propertiesOpen">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ propertyTarget?.name }}</DialogTitle>
        <DialogDescription>文件属性</DialogDescription>
      </DialogHeader>
      <dl v-if="propertyTarget" class="file-properties">
        <div>
          <dt>类型</dt>
          <dd>{{ propertyType }}</dd>
        </div>
        <div>
          <dt>大小</dt>
          <dd>{{ propertyTarget.isDir ? '—' : formatBytes(propertyTarget.size) }}</dd>
        </div>
        <div>
          <dt>修改时间</dt>
          <dd>
            {{
              propertyTarget.mtime ? new Date(propertyTarget.mtime * 1000).toLocaleString() : '未知'
            }}
          </dd>
        </div>
        <div class="file-property-path">
          <dt>路径</dt>
          <dd :title="propertyPath">{{ propertyPath }}</dd>
        </div>
      </dl>
      <DialogFooter>
        <Button variant="outline" @click="copyPath()">
          <ClipboardCopy data-icon="inline-start" />
          复制文件路径
        </Button>
        <Button @click="propertiesOpen = false">完成</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <VideoPreviewDialog
    v-model:open="videoOpen"
    :serial="serial"
    :path="manager.currentPath.value"
    :file="videoTarget"
  />
</template>
