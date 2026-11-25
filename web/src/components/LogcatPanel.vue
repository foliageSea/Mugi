<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Copy, Download, Pause, Play, ScrollText } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Empty, EmptyMedia } from '@/components/ui/empty'
import { errorText } from '@/services/api'
import {
  openLogcat,
  clearDeviceLogcat,
  readLogcatProcesses,
  type LogcatConnection,
} from '@/services/logcat'
import {
  LogcatParser,
  LOGCAT_LEVELS,
  MAX_LOGCAT_ROWS,
  filterLogcat,
  packagePids,
  type LogcatRow,
} from '@/services/logcat-parser'

const props = defineProps<{ serial: string }>()
const rows = shallowRef<LogcatRow[]>([])
const level = ref('V')
const search = ref('')
const pid = ref('')
const packageName = ref('')
const pids = shallowRef<Set<number>>()
const packageStatus = ref('')
const status = ref('正在连接 Logcat…')
const connected = ref(false)
const busy = ref(false)
const clearing = ref(false)
const following = ref(true)
const discarded = ref(0)
const viewport = ref<HTMLElement>()
const scrollTop = ref(0)
const height = ref(300)
const pidInvalid = computed(() => !!pid.value.trim() && !/^[1-9]\d*$/.test(pid.value.trim()))
const packageInvalid = computed(
  () =>
    !!packageName.value.trim() &&
    !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(packageName.value.trim()),
)
const filtered = computed(() =>
  filterLogcat(rows.value, level.value, search.value, pid.value.trim(), pids.value),
)
const rowHeight = 24
const first = computed(() =>
  Math.max(0, Math.min(Math.floor(scrollTop.value / rowHeight) - 5, filtered.value.length - 1)),
)
const visible = computed(() =>
  filtered.value.slice(first.value, first.value + Math.ceil(height.value / rowHeight) + 10),
)
let controller: AbortController | undefined
let clearController: AbortController | undefined
let connection: LogcatConnection | undefined
let parser = new LogcatParser()
let pending: LogcatRow[] = []
let flushTimer: ReturnType<typeof setTimeout> | undefined
let observer: ResizeObserver | undefined

function flush() {
  clearTimeout(flushTimer)
  flushTimer = undefined
  if (!pending.length) return
  const combined = [...rows.value, ...pending]
  discarded.value += Math.max(0, combined.length - MAX_LOGCAT_ROWS)
  rows.value = combined.slice(-MAX_LOGCAT_ROWS)
  pending = []
}
function append(batch: LogcatRow[]) {
  pending.push(...batch)
  if (pending.length > MAX_LOGCAT_ROWS) {
    discarded.value += pending.length - MAX_LOGCAT_ROWS
    pending = pending.slice(-MAX_LOGCAT_ROWS)
  }
  if (!flushTimer) flushTimer = setTimeout(flush, 100)
}
function clearView() {
  clearTimeout(flushTimer)
  flushTimer = undefined
  pending = []
  rows.value = []
  discarded.value = 0
  scrollTop.value = 0
  if (viewport.value) viewport.value.scrollTop = 0
}
function stop() {
  controller?.abort()
  connection?.close()
  connection = undefined
  connected.value = false
  busy.value = false
}
function disconnect() {
  stop()
  append(parser.push(new Uint8Array(), true))
  flush()
  status.value = '已停止采集'
}
async function start() {
  stop()
  clearView()
  parser = new LogcatParser()
  const current = new AbortController()
  controller = current
  busy.value = true
  status.value = '正在连接 Logcat…'
  let exited = false
  try {
    const result = await openLogcat(
      props.serial,
      current.signal,
      (bytes) => {
        if (!current.signal.aborted) append(parser.push(bytes))
      },
      (message) => {
        if (current.signal.aborted) return
        exited = true
        append(parser.push(new Uint8Array(), true))
        flush()
        connected.value = false
        status.value = message
      },
    )
    if (current.signal.aborted) {
      result.close()
      return
    }
    connection = result
    if (!exited) {
      connected.value = true
      status.value = '已连接 · main / system / crash'
    }
  } catch (error) {
    if (!current.signal.aborted) status.value = errorText(error)
  } finally {
    if (controller === current) busy.value = false
  }
}
async function clearDevice() {
  clearing.value = true
  stop()
  const current = new AbortController()
  clearController = current
  try {
    await clearDeviceLogcat(props.serial, current.signal)
    if (current.signal.aborted) return
    clearView()
    toast.success('设备日志缓冲区已清空')
    await start()
  } catch (error) {
    if (!current.signal.aborted) status.value = `清空失败：${errorText(error)}`
  } finally {
    clearing.value = false
  }
}
watch([packageName, connected], ([value, active], [previousPackage], cleanup) => {
  const pkg = value.trim()
  // Retain the last mapping when capture stops, so cached logs remain exportable.
  if (pkg !== previousPackage.trim() || !pkg) pids.value = pkg ? new Set() : undefined
  packageStatus.value = ''
  if (!pkg || packageInvalid.value) return
  if (!active) {
    packageStatus.value = pids.value?.size
      ? '采集已停止，使用最后一次 PID 映射'
      : '连接后解析应用进程'
    return
  }
  const current = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  cleanup(() => {
    current.abort()
    clearTimeout(timer)
  })
  const poll = async () => {
    try {
      const output = await readLogcatProcesses(props.serial, current.signal)
      if (current.signal.aborted) return
      pids.value = packagePids(output, pkg)
      packageStatus.value = pids.value.size
        ? `当前 PID：${[...pids.value].join(', ')}`
        : '应用未运行，等待进程启动…'
    } catch (error) {
      if (current.signal.aborted) return
      pids.value = new Set()
      packageStatus.value = `无法读取应用进程：${errorText(error)}`
    }
    if (!current.signal.aborted) timer = setTimeout(poll, 3000)
  }
  timer = setTimeout(poll, 300)
})
async function toBottom() {
  await nextTick()
  if (viewport.value && following.value) {
    viewport.value.scrollTop = viewport.value.scrollHeight
    scrollTop.value = viewport.value.scrollTop
  }
}
watch([filtered, following], () => {
  void toBottom()
})
function onScroll() {
  scrollTop.value = viewport.value?.scrollTop || 0
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('日志已复制')
  } catch (error) {
    toast.error(`复制失败：${errorText(error)}`)
  }
}
function exportLogs() {
  const blob = new Blob([filtered.value.map((row) => row.raw).join('\n') + '\n'], {
    type: 'text/plain;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `logcat-${props.serial.replace(/[^\w.-]/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
onMounted(() => {
  observer = new ResizeObserver(() => {
    height.value = viewport.value?.clientHeight || 300
    void toBottom()
  })
  observer.observe(viewport.value!)
  void start()
})
onBeforeUnmount(() => {
  stop()
  clearController?.abort()
  clearTimeout(flushTimer)
  observer?.disconnect()
})
</script>

<template>
  <div class="logcat-panel flex min-h-0 flex-col gap-3">
    <FieldGroup class="logcat-filters">
      <Field>
        <FieldLabel for="logcat-level">最低级别</FieldLabel>
        <Select v-model="level">
          <SelectTrigger id="logcat-level" class="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem v-for="item in LOGCAT_LEVELS" :key="item" :value="item">
                {{
                  { V: 'Verbose', D: 'Debug', I: 'Info', W: 'Warn', E: 'Error', F: 'Fatal' }[item]
                }}
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field :data-invalid="pidInvalid">
        <FieldLabel for="logcat-pid">PID</FieldLabel>
        <Input
          id="logcat-pid"
          v-model="pid"
          placeholder="全部进程"
          inputmode="numeric"
          :aria-invalid="pidInvalid"
        />
      </Field>
      <Field :data-invalid="packageInvalid">
        <FieldLabel for="logcat-package">应用包名</FieldLabel>
        <Input
          id="logcat-package"
          v-model="packageName"
          placeholder="com.example.app"
          :aria-invalid="packageInvalid"
        />
      </Field>
      <Field>
        <FieldLabel for="logcat-search">搜索日志</FieldLabel>
        <Input id="logcat-search" v-model="search" placeholder="Tag / 关键词" />
      </Field>
    </FieldGroup>
    <p v-if="pidInvalid || packageInvalid" role="alert" class="text-xs text-destructive">
      {{ pidInvalid ? 'PID 必须是正整数。' : '请输入有效的应用包名。' }}
    </p>
    <p v-if="packageStatus" class="text-xs text-muted-foreground">
      {{ packageStatus }} · 每 3 秒更新，包含 :子进程
    </p>
    <div class="flex flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        :aria-pressed="!following"
        @click="following = !following"
      >
        <component :is="following ? Pause : Play" data-icon="inline-start" />
        {{ following ? '暂停滚动' : '跟随最新' }}
      </Button>
      <Button variant="outline" size="sm" @click="clearView">清空视图</Button>
      <Button variant="outline" size="sm" :disabled="!connected || clearing" @click="clearDevice">
        清空设备日志
      </Button>
      <Button
        variant="outline"
        size="sm"
        :disabled="!filtered.length"
        @click="copy(filtered.map((row) => row.raw).join('\n'))"
      >
        <Copy data-icon="inline-start" />
        复制筛选日志
      </Button>
      <Button variant="outline" size="sm" :disabled="!filtered.length" @click="exportLogs">
        <Download data-icon="inline-start" />
        导出日志
      </Button>
      <Button
        v-if="connected || busy"
        variant="outline"
        size="sm"
        :disabled="clearing"
        @click="disconnect"
      >
        停止采集
      </Button>
      <Button v-else variant="outline" size="sm" :disabled="clearing" @click="start">
        重新连接
      </Button>
    </div>
    <div
      ref="viewport"
      class="logcat-viewport"
      tabindex="0"
      role="region"
      aria-label="Logcat 日志"
      @scroll="onScroll"
      @wheel="following = false"
      @touchstart="following = false"
      @keydown.page-up="following = false"
      @keydown.home="following = false"
    >
      <Empty v-if="!filtered.length" class="logcat-empty" aria-label="暂无匹配日志">
        <EmptyMedia variant="icon" class="mb-0"><ScrollText /></EmptyMedia>
      </Empty>
      <div
        v-else
        class="logcat-rows"
        :style="{
          paddingTop: `${first * rowHeight}px`,
          paddingBottom: `${Math.max(0, filtered.length - first - visible.length) * rowHeight}px`,
        }"
      >
        <div v-for="row in visible" :key="row.id" class="logcat-row" :data-level="row.level || 'V'">
          <Button
            variant="ghost"
            size="icon-xs"
            :aria-label="`复制日志 ${row.id + 1}`"
            @click="copy(row.raw)"
          >
            <Copy />
          </Button>
          <span>{{ row.raw }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
