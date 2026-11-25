import { computed, onBeforeUnmount, ref, type Ref } from 'vue'
import { toast } from 'vue-sonner'
import { api, errorText } from '@/services/api'
import { formatBytes, remoteFileKind, remotePathJoin, uploadFiles } from '@/services/files'
import type { RemoteFile } from '@/types'

export type FileView = 'icons' | 'list'
export type FileSort = 'name' | 'date' | 'size' | 'type'
export type FileTransferMode = 'copy' | 'move'
export type TransferTaskDirection = 'upload' | 'download'
export type TransferTaskStatus = 'running' | 'completed' | 'failed'

export interface TransferTask {
  id: number
  direction: TransferTaskDirection
  status: TransferTaskStatus
  name: string
  currentName: string
  phase: string
  loaded: number
  total: number
  index: number
  count: number
  error?: string
}

const ROOT = '/sdcard'
const DEFAULT_PATH = `${ROOT}/Download`
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

function isNavigablePath(path: string) {
  return path !== ROOT && path.startsWith(`${ROOT}/`)
}

export function useFileManager(serial: Ref<string>) {
  const files = ref<RemoteFile[]>([])
  const currentPath = ref(DEFAULT_PATH)
  const loading = ref(false)
  const operating = ref(false)
  const progress = ref('')
  const tasks = ref<TransferTask[]>([])
  const error = ref('')
  const query = ref('')
  const selectedName = ref('')
  const selectedNames = ref(new Set<string>())
  const view = ref<FileView>('icons')
  const sort = ref<FileSort>('name')
  const history = ref<string[]>([DEFAULT_PATH])
  const historyIndex = ref(0)
  let controller: AbortController | undefined
  let transferController: AbortController | undefined
  let nextTaskId = 1
  let selectionAnchor = ''
  const clipboard = ref<{
    serial: string
    sourcePath: string
    mode: FileTransferMode
    items: { path: string; name: string; isDir: boolean }[]
  }>()

  const selected = computed(
    () => files.value.find((file) => file.name === selectedName.value) || null,
  )
  const selectedFiles = computed(() =>
    files.value.filter((file) => selectedNames.value.has(file.name)),
  )
  const canBack = computed(() => historyIndex.value > 0)
  const canForward = computed(() => historyIndex.value < history.value.length - 1)
  const canGoUp = computed(() => {
    if (!isNavigablePath(currentPath.value)) return false
    const parent = currentPath.value.slice(0, currentPath.value.lastIndexOf('/')) || ROOT
    return parent !== ROOT
  })
  const breadcrumbs = computed(() => {
    const parts = currentPath.value.slice(ROOT.length).split('/').filter(Boolean)
    return [
      { label: '内部存储', path: ROOT },
      ...parts.map((label, index) => ({
        label,
        path: `${ROOT}/${parts.slice(0, index + 1).join('/')}`,
      })),
    ]
  })
  const visibleFiles = computed(() => {
    const needle = query.value.trim().toLocaleLowerCase()
    const direction = sort.value === 'date' || sort.value === 'size' ? -1 : 1
    return files.value
      .filter((file) => !needle || file.name.toLocaleLowerCase().includes(needle))
      .slice()
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        let result = 0
        if (sort.value === 'date') result = a.mtime - b.mtime
        else if (sort.value === 'size') result = a.size - b.size
        else if (sort.value === 'type')
          result = collator.compare(
            remoteFileKind(a.name, a.isDir),
            remoteFileKind(b.name, b.isDir),
          )
        if (!result) result = collator.compare(a.name, b.name)
        return result * direction
      })
  })
  const statusText = computed(() => {
    if (selectedFiles.value.length > 1) {
      const bytes = selectedFiles.value.reduce((sum, file) => sum + (file.isDir ? 0 : file.size), 0)
      return `${selectedFiles.value.length} 个项目已选择${bytes ? ` · ${formatBytes(bytes)}` : ''}`
    }
    if (selected.value) {
      return selected.value.isDir
        ? `${selected.value.name} · 文件夹`
        : `${selected.value.name} · ${formatBytes(selected.value.size)}`
    }
    if (query.value) return `${visibleFiles.value.length} 个搜索结果`
    return `${files.value.length} 个项目`
  })
  const canPaste = computed(
    () =>
      !!clipboard.value?.items.length &&
      clipboard.value.serial === serial.value &&
      clipboard.value.sourcePath !== currentPath.value,
  )
  const activeTransferCount = computed(
    () => tasks.value.filter((task) => task.status === 'running').length,
  )
  const hasActiveTransfer = computed(() => activeTransferCount.value > 0)

  function beginTask(direction: TransferTaskDirection, name: string, count = 1) {
    const task: TransferTask = {
      id: nextTaskId++,
      direction,
      status: 'running',
      name,
      currentName: name,
      phase: direction === 'upload' ? '准备上传…' : '准备下载…',
      loaded: 0,
      total: 0,
      index: 0,
      count,
    }
    tasks.value = [task, ...tasks.value].slice(0, 12)
    return task.id
  }

  function updateTask(id: number, patch: Partial<TransferTask>) {
    const task = tasks.value.find((item) => item.id === id)
    if (task) Object.assign(task, patch)
  }

  function finishTask(id: number, status: Exclude<TransferTaskStatus, 'running'>, error = '') {
    const task = tasks.value.find((item) => item.id === id)
    if (!task) return
    task.status = status
    task.error = error || undefined
    if (status === 'completed' && task.total > 0) task.loaded = task.total
    if (status === 'completed') task.phase = '已完成'
  }

  function setSelected(names: Iterable<string>, primary = '') {
    const available = new Set(files.value.map((file) => file.name))
    const next = new Set([...names].filter((name) => available.has(name)))
    selectedNames.value = next
    selectedName.value = primary && next.has(primary) ? primary : next.values().next().value || ''
  }

  function setSelection(names: Iterable<string>, primary = '') {
    setSelected(names, primary)
    selectionAnchor = primary
  }

  function clearSelection() {
    selectedNames.value = new Set()
    selectedName.value = ''
    selectionAnchor = ''
  }

  function selectOnly(name: string) {
    setSelected([name], name)
    selectionAnchor = name
  }

  function selectFile(name: string, toggle = false, range = false) {
    if (range && selectionAnchor) {
      const names = visibleFiles.value.map((file) => file.name)
      const start = names.indexOf(selectionAnchor)
      const end = names.indexOf(name)
      if (start >= 0 && end >= 0) {
        const selected = toggle ? new Set(selectedNames.value) : new Set<string>()
        for (const item of names.slice(Math.min(start, end), Math.max(start, end) + 1))
          selected.add(item)
        setSelected(selected, name)
        return
      }
    }
    if (toggle) {
      const selected = new Set(selectedNames.value)
      if (selected.has(name)) selected.delete(name)
      else selected.add(name)
      setSelected(selected, name)
      selectionAnchor = name
      return
    }
    selectOnly(name)
  }

  function selectAll() {
    setSelected(
      visibleFiles.value.map((file) => file.name),
      visibleFiles.value[0]?.name,
    )
  }

  async function load(path = currentPath.value) {
    if (!isNavigablePath(path)) {
      files.value = []
      error.value = '不能打开内部存储根目录'
      return
    }
    controller?.abort()
    const currentController = new AbortController()
    controller = currentController
    loading.value = true
    error.value = ''
    clearSelection()
    try {
      const result = await api.files(serial.value, path, currentController.signal)
      if (controller !== currentController || currentController.signal.aborted) return
      files.value = result.files || []
      const resolvedPath = result.path || path
      if (!isNavigablePath(resolvedPath)) {
        files.value = []
        error.value = '不能打开内部存储根目录'
        return
      }
      currentPath.value = resolvedPath
    } catch (cause) {
      if (controller !== currentController || currentController.signal.aborted) return
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      files.value = []
      error.value = errorText(cause)
    } finally {
      if (controller === currentController) loading.value = false
    }
  }

  function reset() {
    controller?.abort()
    transferController?.abort()
    transferController = undefined
    clipboard.value = undefined
    currentPath.value = DEFAULT_PATH
    history.value = [DEFAULT_PATH]
    historyIndex.value = 0
    files.value = []
    clearSelection()
    query.value = ''
    error.value = ''
    tasks.value = []
  }

  async function navigate(path: string, record = true) {
    if (!isNavigablePath(path)) {
      toast.error('不能打开内部存储根目录')
      return
    }
    if (record && path !== currentPath.value) {
      history.value = history.value.slice(0, historyIndex.value + 1)
      history.value.push(path)
      historyIndex.value = history.value.length - 1
    }
    currentPath.value = path
    query.value = ''
    await load(path)
  }

  async function back() {
    if (!canBack.value) return
    historyIndex.value--
    await navigate(history.value[historyIndex.value], false)
  }

  async function forward() {
    if (!canForward.value) return
    historyIndex.value++
    await navigate(history.value[historyIndex.value], false)
  }

  async function up() {
    if (!canGoUp.value) return
    const parent = currentPath.value.slice(0, currentPath.value.lastIndexOf('/')) || ROOT
    if (parent === ROOT) return
    await navigate(parent)
  }

  async function createFolder(name: string) {
    operating.value = true
    try {
      const result = await api.createDirectory(
        serial.value,
        remotePathJoin(currentPath.value, name),
      )
      await load()
      selectOnly(result.path.split('/').at(-1) || name)
      toast.success(`已创建“${name}”`)
      return true
    } catch (cause) {
      toast.error(`新建文件夹失败：${errorText(cause)}`)
      return false
    } finally {
      operating.value = false
    }
  }

  async function renameSelected(name: string) {
    if (!selected.value || selectedFiles.value.length !== 1) return false
    const oldName = selected.value.name
    operating.value = true
    try {
      const result = await api.renameFile(
        serial.value,
        remotePathJoin(currentPath.value, oldName),
        name,
      )
      await load()
      selectOnly(result.path.split('/').at(-1) || name)
      toast.success(`已将“${oldName}”重命名为“${name}”`)
      return true
    } catch (cause) {
      toast.error(`重命名失败：${errorText(cause)}`)
      return false
    } finally {
      operating.value = false
    }
  }

  async function deleteSelected(names = selectedFiles.value.map((file) => file.name)) {
    if (!names.length) return false
    const paths = names.map((name) => remotePathJoin(currentPath.value, name))
    operating.value = true
    try {
      await api.deleteFiles(serial.value, paths)
      await load()
      toast.success(names.length === 1 ? `已删除“${names[0]}”` : `已删除 ${names.length} 个项目`)
      return true
    } catch (cause) {
      await load()
      toast.error(`删除失败：${errorText(cause)}`)
      return false
    } finally {
      operating.value = false
    }
  }

  function stageTransfer(mode: FileTransferMode) {
    if (!selectedFiles.value.length) return
    clipboard.value = {
      serial: serial.value,
      sourcePath: currentPath.value,
      mode,
      items: selectedFiles.value.map((file) => ({
        path: remotePathJoin(currentPath.value, file.name),
        name: file.name,
        isDir: file.isDir,
      })),
    }
    toast.success(
      `${selectedFiles.value.length} 个项目已${mode === 'copy' ? '复制' : '剪切'}，请前往目标文件夹粘贴`,
    )
  }

  async function paste() {
    const staged = clipboard.value
    if (!staged || !canPaste.value || operating.value) return false
    const label = staged.mode === 'copy' ? '复制' : '移动'
    operating.value = true
    progress.value = `正在${label} ${staged.items.length} 个项目…`
    try {
      await api.transferFiles(
        serial.value,
        staged.items.map((item) => item.path),
        currentPath.value,
        staged.mode,
      )
      const names = staged.items.map((item) => item.name)
      if (staged.mode === 'move') clipboard.value = undefined
      await load()
      setSelected(names, names[0])
      toast.success(`已${label} ${names.length} 个项目`)
      return true
    } catch (cause) {
      await load()
      toast.error(`${label}失败：${errorText(cause)}`)
      return false
    } finally {
      operating.value = false
      progress.value = ''
    }
  }

  async function upload(list: File[], scan?: (path: string) => void) {
    if (!list.length || progress.value || hasActiveTransfer.value) return
    const taskId = beginTask(
      'upload',
      list.length === 1 ? list[0]!.name : `${list.length} 个文件`,
      list.length,
    )
    try {
      const result = await uploadFiles(
        serial.value,
        currentPath.value,
        list,
        (label) => updateTask(taskId, { phase: label }),
        scan,
        (value) =>
          updateTask(taskId, {
            currentName: value.fileName,
            index: value.index,
            count: value.count,
            loaded: value.loaded,
            total: value.total,
          }),
      )
      finishTask(taskId, result.failed ? 'failed' : 'completed')
      await load()
    } catch (cause) {
      finishTask(taskId, 'failed', errorText(cause))
      toast.error(`上传失败：${errorText(cause)}`)
    }
  }

  async function download(file: RemoteFile) {
    if (file.isDir || progress.value || hasActiveTransfer.value) return
    const path = remotePathJoin(currentPath.value, file.name)
    const taskId = beginTask('download', file.name)
    const currentController = new AbortController()
    transferController?.abort()
    transferController = currentController
    updateTask(taskId, { phase: '正在下载…', total: file.size })
    try {
      const blob = await api.download(
        serial.value,
        path,
        file.size,
        currentController.signal,
        (value) => updateTask(taskId, { loaded: value.loaded, total: value.total || file.size }),
      )
      if (currentController.signal.aborted) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
      finishTask(taskId, 'completed')
    } catch (cause) {
      if (!currentController.signal.aborted) {
        finishTask(taskId, 'failed', errorText(cause))
        toast.error(`下载失败：${errorText(cause)}`)
      }
    } finally {
      if (transferController === currentController) transferController = undefined
    }
  }

  onBeforeUnmount(() => {
    controller?.abort()
    transferController?.abort()
  })

  return {
    files,
    currentPath,
    loading,
    operating,
    progress,
    tasks,
    activeTransferCount,
    hasActiveTransfer,
    error,
    query,
    selectedName,
    selectedNames,
    selected,
    selectedFiles,
    view,
    sort,
    history,
    historyIndex,
    canBack,
    canForward,
    canGoUp,
    breadcrumbs,
    visibleFiles,
    statusText,
    clipboard,
    canPaste,
    load,
    reset,
    navigate,
    back,
    forward,
    up,
    createFolder,
    renameSelected,
    deleteSelected,
    clearSelection,
    setSelection,
    selectOnly,
    selectFile,
    selectAll,
    stageTransfer,
    paste,
    upload,
    download,
  }
}
