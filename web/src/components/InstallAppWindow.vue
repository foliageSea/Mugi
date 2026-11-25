<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { CheckCircle2, LoaderCircle, PackagePlus, Upload } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { installAPKSet, installError } from '@/services/workbench'
import { formatBytes } from '@/services/files'
import { cn } from '@/lib/utils'
import WindowFrame from './WindowFrame.vue'

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ serial: string; deviceName: string }>()
const emit = defineEmits<{ installed: [] }>()

const picker = ref<HTMLInputElement>()
const apks = ref<File[]>([])
const apk = computed(() => apks.value[0] || null)
const results = ref<{ name: string; ok: boolean; message: string }[]>([])
const installing = ref(false)
const installed = ref(false)
const status = ref('')
const error = ref('')
const dragDepth = ref(0)
const dragging = computed(() => dragDepth.value > 0)
let generation = 0
watch([() => props.serial, open], () => {
  generation++
})
onBeforeUnmount(() => {
  generation++
})

watch(open, (visible) => {
  if (!visible || installing.value) return
  reset()
})

function reset() {
  apks.value = []
  results.value = []
  installed.value = false
  status.value = ''
  error.value = ''
  dragDepth.value = 0
  if (picker.value) picker.value.value = ''
}

function close() {
  if (!installing.value) open.value = false
}

function choose(files: File[]) {
  dragDepth.value = 0
  if (picker.value) picker.value.value = ''
  installed.value = false
  status.value = ''
  results.value = []
  error.value = ''
  const file = files[0]
  if (!file) return
  if (files.length > 1) {
    apks.value = []
    error.value = '请选择一个 APK 文件'
    return
  }
  if (!file.name.toLocaleLowerCase().endsWith('.apk')) {
    apks.value = []
    error.value = '请选择扩展名为 .apk 的 Android 安装包'
    return
  }
  if (!file.size) {
    apks.value = []
    error.value = 'APK 文件为空，请重新选择'
    return
  }
  apks.value = [file]
  void install()
}

function dragEnter(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files') || installing.value) return
  dragDepth.value++
}

function dragLeave() {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}

async function install() {
  const file = apk.value
  if (!file || installing.value) return
  const target = props.serial
  const attempt = generation
  const active = () => generation === attempt && props.serial === target && open.value
  installing.value = true
  installed.value = false
  error.value = ''
  results.value = []
  try {
    try {
      await installAPKSet(target, [file], { downgrade: false, test: false }, (message) => {
        if (active()) status.value = message
      })
      if (!active()) return
      results.value.push({ name: file.name, ok: true, message: '安装成功' })
    } catch (cause) {
      if (!active()) return
      results.value.push({ name: file.name, ok: false, message: installError(cause) })
    }
    if (!active()) return
    installed.value = results.value[0]?.ok === true
    status.value = installed.value ? '安装完成' : '安装失败'
    error.value = installed.value ? '' : (results.value[0]?.message ?? '安装失败')
    if (installed.value) {
      emit('installed')
      toast.success('应用安装成功')
    }
    if (error.value) toast.error('应用安装失败')
  } finally {
    installing.value = false
    if (!active()) reset()
  }
}
</script>

<template>
  <!-- prettier-ignore -->
  <Transition name="window-motion" appear>
  <WindowFrame
    v-if="open"
    id="app-installer"
    title="安装应用"
    control-label="应用安装器"
    class="installer-window"
    titlebar-class="installer-window-toolbar"
    resize-class="file-resize-handle"
    resize-label="调节应用安装器窗口大小"
    :geometry="{
      size: { width: 660, height: 450 },
      minSize: { width: 480, height: 440 },
      margin: 24,
      titlebarHeight: 48,
      mobileFullscreen: true,
    }"
    data-testid="installer-window"
    role="dialog"
    :close-on-escape="!installing"
    @close="close"
  >
    <h2 class="sr-only">安装应用</h2>
    <template #titlebar>
      <strong class="installer-window-title">
        <PackagePlus />
        安装应用
      </strong>
    </template>

    <div class="installer-window-content">
      <input
        ref="picker"
        type="file"
        accept=".apk,application/vnd.android.package-archive"
        class="sr-only"
        aria-label="选择 APK 文件"
        :disabled="installing"
        @change="choose(Array.from(($event.target as HTMLInputElement).files || []))"
      />

      <Empty
        :class="
          cn(
            'installer-dropzone min-h-64 border-2 transition-colors',
            dragging && 'border-primary bg-accent',
            installed && 'border-primary',
          )
        "
        @dragenter.prevent="dragEnter"
        @dragover.prevent
        @dragleave.prevent="dragLeave"
        @drop.prevent="!installing && choose(Array.from($event.dataTransfer?.files || []))"
      >
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LoaderCircle v-if="installing" class="animate-spin" />
            <CheckCircle2 v-else-if="installed" />
            <PackagePlus v-else />
          </EmptyMedia>
          <EmptyTitle>
            {{
              installed
                ? '应用安装成功'
                : apk
                  ? apk.name
                  : dragging
                    ? '松开以选择 APK'
                    : '选择 Android 安装包'
            }}
          </EmptyTitle>
          <EmptyDescription>
            <template v-if="installing">{{ status }}</template>
            <template v-else-if="installed">
              {{ apks.length }} 个 APK 已安装到 {{ deviceName }}
            </template>
            <template v-else-if="apk">
              {{ apks.length }} 个 APK ·
              {{ formatBytes(apks.reduce((sum, file) => sum + file.size, 0)) }}
            </template>
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent v-if="!installing">
          <Button variant="outline" @click="picker?.click()">
            <Upload data-icon="inline-start" />
            {{ apk ? '重新选择' : '选择 APK' }}
          </Button>
        </EmptyContent>
      </Empty>
      <ul v-if="results.length" class="text-sm flex flex-col gap-1" aria-label="安装结果">
        <li v-for="(result, i) in results" :key="i">
          {{ result.ok ? '✓' : '×' }} {{ result.name }} · {{ result.ok ? '安装成功' : '安装失败' }}
        </li>
      </ul>
      <p v-if="error" class="text-destructive text-sm whitespace-pre-wrap" role="alert">
        {{ error }}
      </p>
    </div>
    </WindowFrame>
  </Transition>
</template>
