<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ArrowDownToLine, CircleAlert } from '@lucide/vue'
import Plyr from 'plyr'
import 'plyr/dist/plyr.css'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api } from '@/services/api'
import { formatBytes, remotePathJoin } from '@/services/files'
import type { RemoteFile } from '@/types'

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{
  serial: string
  path: string
  file: RemoteFile | null
}>()

const videoElement = ref<HTMLVideoElement>()
const failed = ref(false)
const loading = ref(false)
let player: Plyr | undefined

const remotePath = computed(() => (props.file ? remotePathJoin(props.path, props.file.name) : ''))
const source = ref('')
const downloadUrl = computed(() =>
  source.value.startsWith('blob:')
    ? source.value
    : props.file
      ? api.pullUrl(props.serial, remotePath.value)
      : '',
)
let request: AbortController | undefined
function clearSource() {
  request?.abort()
  destroyPlayer()
  if (source.value.startsWith('blob:')) URL.revokeObjectURL(source.value)
  source.value = ''
}
watch(
  () => [open.value, props.serial, remotePath.value] as const,
  async ([visible]) => {
    clearSource()
    failed.value = false
    if (!visible || !props.file) return
    const controller = new AbortController()
    request = controller
    loading.value = true
    try {
      const url = await api.fileUrl(props.serial, remotePath.value, controller.signal)
      if (controller.signal.aborted) {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url)
        return
      }
      source.value = url
    } catch {
      if (!controller.signal.aborted) failed.value = true
    } finally {
      if (request === controller) loading.value = false
    }
  },
  { immediate: true },
)

function destroyPlayer() {
  player?.destroy()
  player = undefined
}

watch(
  () => [open.value, source.value] as const,
  async ([visible]) => {
    destroyPlayer()
    failed.value = false
    if (!visible || !source.value) return
    await nextTick()
    if (!open.value || !videoElement.value) return
    player = new Plyr(videoElement.value, {
      controls: [
        'play-large',
        'restart',
        'rewind',
        'play',
        'fast-forward',
        'progress',
        'current-time',
        'duration',
        'mute',
        'volume',
        'settings',
        'pip',
        'fullscreen',
      ],
      keyboard: { focused: true, global: false },
      settings: ['speed'],
      tooltips: { controls: true, seek: true },
    })
  },
  { flush: 'post' },
)

onBeforeUnmount(clearSource)
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="media-preview-dialog">
      <DialogHeader>
        <DialogTitle class="truncate">{{ file?.name || '视频预览' }}</DialogTitle>
        <DialogDescription>
          {{ file ? `${formatBytes(file.size)} · 视频预览` : '视频预览' }}
        </DialogDescription>
      </DialogHeader>

      <div class="video-preview-stage">
        <video
          v-if="file && source"
          ref="videoElement"
          :key="source"
          controls
          playsinline
          preload="metadata"
          :src="source"
          :aria-label="`预览视频 ${file.name}`"
          @loadedmetadata="failed = false"
          @error="failed = true"
        />
        <p v-if="loading" role="status">正在读取视频…</p>
        <div v-if="failed" class="video-preview-error" role="alert">
          <CircleAlert />
          <strong>无法播放这个视频</strong>
          <span>当前浏览器可能不支持此文件的格式或编码，你仍可以下载后查看。</span>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">关闭</Button>
        <Button v-if="file && source" as-child>
          <a :href="downloadUrl" :download="file.name">
            <ArrowDownToLine data-icon="inline-start" />
            下载视频
          </a>
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
