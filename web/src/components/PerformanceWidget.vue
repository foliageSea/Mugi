<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Activity, Pause, Play, X } from '@lucide/vue'
import { VisArea, VisLine, VisXYContainer } from '@unovis/vue'
import { Button } from '@/components/ui/button'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { useWindowGesture } from '@/composables/useWindowGesture'
import {
  calculateMetrics,
  readMetrics,
  type MetricSample,
  type Metrics,
  type Snapshot,
} from '@/services/metrics'
import { ApiError, errorText } from '@/services/api'
import { formatBytes } from '@/services/files'

const props = defineProps<{ serial: string; deviceName: string }>()
const emit = defineEmits<{ close: []; sample: [sample: MetricSample] }>()

const POSITION_KEY = 'mugi.performance-widget-position'
const EDGE = 8
const root = ref<HTMLElement>()
const position = reactive({ x: 0, y: 0 })
const placed = ref(false)
const { manipulating, start: startGesture } = useWindowGesture()
let observer: ResizeObserver | undefined

const metrics = ref<Metrics>()
const error = ref('')
const paused = ref(false)
type MetricPoint = { index: number; cpu?: number; memory?: number }
const history = ref<MetricPoint[]>([])
let sampleIndex = 0
const maxHistory = 60
let previous: Snapshot | undefined
let controller: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined
const physical = computed(
  () =>
    metrics.value?.interfaces.filter((i) =>
      /^(wlan\d+|wifi\d+|eth\d+|rmnet(?:_data)?\d+|ccmni\d+|pdp\d+)$/.test(i.name),
    ) || [],
)
const totals = computed(() => {
  if (!physical.value.length || physical.value.some((i) => i.rx === null || i.tx === null))
    return null
  return physical.value.reduce((sum, i) => ({ rx: sum.rx + i.rx!, tx: sum.tx + i.tx! }), {
    rx: 0,
    tx: 0,
  })
})
const rate = (value: number | null | undefined) =>
  value == null ? '—' : `${formatBytes(Math.round(value))}/s`
const percent = (value: number | null | undefined) => (value == null ? '—' : `${value.toFixed(1)}%`)
const memoryPercent = computed(() =>
  metrics.value?.memory ? (metrics.value.memory.used / metrics.value.memory.total) * 100 : null,
)
const cpuChartConfig = {
  cpu: { label: 'CPU', color: 'var(--primary)' },
} satisfies ChartConfig
const memoryChartConfig = {
  memory: { label: '内存', color: 'var(--success)' },
} satisfies ChartConfig
const pointX = (point: MetricPoint) => point.index
const cpuY = (point: MetricPoint) => point.cpu
const memoryY = (point: MetricPoint) => point.memory

function stop() {
  clearTimeout(timer)
  controller?.abort()
  controller = undefined
  previous = undefined
}
function start() {
  stop()
  if (paused.value || document.hidden) return
  const current = new AbortController()
  controller = current
  const poll = async () => {
    let retry = true
    try {
      const snapshot = await readMetrics(props.serial, current.signal)
      if (current.signal.aborted) return
      const next = calculateMetrics(snapshot, previous)
      metrics.value = next
      previous = snapshot
      emit('sample', { snapshot, metrics: next })
      error.value = ''
      const memory = next.memory ? (next.memory.used / next.memory.total) * 100 : undefined
      history.value = [
        ...history.value.slice(-(maxHistory - 1)),
        { index: sampleIndex++, cpu: next.cpu ?? undefined, memory },
      ]
    } catch (cause) {
      if (current.signal.aborted) return
      error.value = errorText(cause)
      metrics.value = undefined
      previous = undefined
      retry = !(cause instanceof ApiError && cause.status === 501)
    }
    if (!current.signal.aborted && retry) timer = setTimeout(poll, error.value ? 3000 : 1000)
  }
  void poll()
}
function toggle() {
  paused.value = !paused.value
  start()
}

function readPosition() {
  try {
    const value = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null')
    return Number.isFinite(value?.x) && Number.isFinite(value?.y)
      ? { x: Number(value.x), y: Number(value.y) }
      : null
  } catch {
    return null
  }
}
function savePosition() {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify({ x: position.x, y: position.y }))
  } catch {
    /* optional preference */
  }
}
function clamp() {
  const area = root.value?.parentElement
  if (!area || !root.value) return
  const maxX = area.clientWidth - root.value.offsetWidth - EDGE
  const maxY = area.clientHeight - root.value.offsetHeight - EDGE
  position.x = Math.max(EDGE, Math.min(position.x, maxX))
  position.y = Math.max(EDGE, Math.min(position.y, maxY))
}
function drag(event: PointerEvent) {
  if ((event.target as HTMLElement).closest('button,a,input')) return
  const initial = { ...position }
  startGesture(event, 'move', (dx, dy) => {
    position.x = initial.x + dx
    position.y = initial.y + dy
    clamp()
  })
}
function nudge(event: KeyboardEvent) {
  if (event.target !== root.value) return
  const step = event.shiftKey ? 40 : 10
  const delta = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  }[event.key]
  if (!delta) return
  event.preventDefault()
  position.x += delta[0]!
  position.y += delta[1]!
  clamp()
  savePosition()
}
watch(manipulating, (value) => {
  if (!value) savePosition()
})

onMounted(async () => {
  start()
  document.addEventListener('visibilitychange', start)
  await nextTick()
  const area = root.value?.parentElement
  if (!area || !root.value) return
  const saved = readPosition()
  position.x = saved?.x ?? area.clientWidth - root.value.offsetWidth - 20
  position.y = saved?.y ?? 20
  clamp()
  placed.value = true
  observer = new ResizeObserver(clamp)
  observer.observe(area)
  observer.observe(root.value)
})
onBeforeUnmount(() => {
  stop()
  observer?.disconnect()
  document.removeEventListener('visibilitychange', start)
})
</script>

<template>
  <section
    ref="root"
    class="performance-widget"
    :class="{ dragging: manipulating }"
    role="region"
    aria-label="性能监控小组件"
    tabindex="0"
    data-testid="performance-widget"
    :data-paused="paused"
    :style="{
      '--widget-x': `${position.x}px`,
      '--widget-y': `${position.y}px`,
      visibility: placed ? undefined : 'hidden',
    }"
    @pointerdown="drag"
    @keydown="nudge"
  >
    <header class="performance-widget-header">
      <span class="performance-widget-icon" aria-hidden="true"><Activity /></span>
      <span class="performance-widget-heading">
        <strong>性能监控</strong>
        <span :title="deviceName">{{ deviceName }}</span>
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        :aria-label="paused ? '继续监控' : '暂停监控'"
        :title="paused ? '继续监控' : '暂停监控'"
        @click="toggle"
      >
        <Play v-if="paused" />
        <Pause v-else />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="关闭性能监控小组件"
        title="关闭小组件"
        @click="emit('close')"
      >
        <X />
      </Button>
    </header>
    <p v-if="error" role="alert" class="performance-widget-error">
      <span>{{ error }}</span>
      <button type="button" @click="start">重试</button>
    </p>
    <dl class="performance-widget-metrics">
      <div class="performance-widget-metric">
        <dt>CPU</dt>
        <dd data-testid="metric-cpu">{{ percent(metrics?.cpu) }}</dd>
        <ChartContainer
          :config="cpuChartConfig"
          class="performance-widget-chart"
          data-testid="cpu-chart"
          :data-points="history.length"
        >
          <VisXYContainer :data="history" :y-domain="[0, 100]">
            <VisArea
              :x="pointX"
              :y="cpuY"
              color="var(--color-cpu)"
              :baseline="0"
              :opacity="0.18"
              :duration="0"
            />
            <VisLine
              :x="pointX"
              :y="cpuY"
              color="var(--color-cpu)"
              :line-width="1.5"
              :duration="0"
            />
          </VisXYContainer>
        </ChartContainer>
      </div>
      <div class="performance-widget-metric">
        <dt>内存</dt>
        <dd data-testid="metric-memory">{{ percent(memoryPercent) }}</dd>
        <ChartContainer
          :config="memoryChartConfig"
          class="performance-widget-chart"
          data-testid="memory-chart"
          :data-points="history.length"
        >
          <VisXYContainer :data="history" :y-domain="[0, 100]">
            <VisArea
              :x="pointX"
              :y="memoryY"
              color="var(--color-memory)"
              :baseline="0"
              :opacity="0.18"
              :duration="0"
            />
            <VisLine
              :x="pointX"
              :y="memoryY"
              color="var(--color-memory)"
              :line-width="1.5"
              :duration="0"
            />
          </VisXYContainer>
        </ChartContainer>
        <p v-if="metrics?.memory">
          {{ `${formatBytes(metrics.memory.used)} / ${formatBytes(metrics.memory.total)}` }}
        </p>
      </div>
      <div class="performance-widget-rate">
        <dt>
          <span aria-hidden="true">↑</span>
          上传
        </dt>
        <dd data-testid="metric-tx">{{ rate(totals?.tx) }}</dd>
      </div>
      <div class="performance-widget-rate">
        <dt>
          <span aria-hidden="true">↓</span>
          下载
        </dt>
        <dd data-testid="metric-rx">{{ rate(totals?.rx) }}</dd>
      </div>
    </dl>
  </section>
</template>
