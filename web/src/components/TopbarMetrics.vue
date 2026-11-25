<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  calculateMetrics,
  readMetrics,
  type MetricSample,
  type Metrics,
  type Snapshot,
} from '@/services/metrics'

const props = defineProps<{
  serial: string
  connected: boolean
  paused: boolean
  sample?: MetricSample
}>()
const metrics = ref<Metrics>()
let previous: Snapshot | undefined
let controller: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined

const physical = computed(
  () =>
    metrics.value?.interfaces.filter((item) =>
      /^(wlan\d+|wifi\d+|eth\d+|rmnet(?:_data)?\d+|ccmni\d+|pdp\d+)$/.test(item.name),
    ) || [],
)
const totals = computed(() => {
  if (!physical.value.length || physical.value.some((item) => item.rx === null || item.tx === null))
    return null
  return physical.value.reduce((sum, item) => ({ rx: sum.rx + item.rx!, tx: sum.tx + item.tx! }), {
    rx: 0,
    tx: 0,
  })
})
const memoryPercent = computed(() =>
  metrics.value?.memory ? (metrics.value.memory.used / metrics.value.memory.total) * 100 : null,
)
const percent = (value: number | null | undefined) =>
  value == null ? '—' : `${Math.round(value)}%`
function rate(value: number | null | undefined) {
  if (value == null) return { value: '—', unit: '' }
  if (value < 1024) return { value: String(Math.round(value)), unit: 'B/s' }
  if (value < 1024 ** 2) return { value: (value / 1024).toFixed(1), unit: 'K/s' }
  if (value < 1024 ** 3) return { value: (value / 1024 ** 2).toFixed(1), unit: 'M/s' }
  return { value: (value / 1024 ** 3).toFixed(1), unit: 'G/s' }
}
const uploadRate = computed(() => rate(totals.value?.tx))
const downloadRate = computed(() => rate(totals.value?.rx))

function stop() {
  clearTimeout(timer)
  controller?.abort()
  controller = undefined
  previous = undefined
}
function start() {
  stop()
  if (!props.connected || !props.serial || props.paused || document.hidden) return
  const current = new AbortController()
  controller = current
  const poll = async () => {
    let delay = 2000
    try {
      const snapshot = await readMetrics(props.serial, current.signal)
      if (current.signal.aborted) return
      metrics.value = calculateMetrics(snapshot, previous)
      previous = snapshot
    } catch {
      if (current.signal.aborted) return
      previous = undefined
      delay = 5000
    }
    if (!current.signal.aborted) timer = setTimeout(poll, delay)
  }
  void poll()
}

watch(
  () => [props.serial, props.connected],
  () => {
    metrics.value = undefined
    start()
  },
  { immediate: true },
)
watch(
  () => props.sample,
  (sample) => {
    if (!sample) return
    metrics.value = sample.metrics
    previous = sample.snapshot
  },
  { immediate: true },
)
watch(() => props.paused, start)
onMounted(() => document.addEventListener('visibilitychange', start))
onBeforeUnmount(() => {
  stop()
  document.removeEventListener('visibilitychange', start)
})
</script>

<template>
  <dl v-if="connected" class="topbar-metrics" aria-label="设备性能">
    <div class="topbar-metric">
      <dt>CPU</dt>
      <dd data-testid="topbar-metric-cpu">{{ percent(metrics?.cpu) }}</dd>
    </div>
    <div class="topbar-metric">
      <dt>MEM</dt>
      <dd data-testid="topbar-metric-memory">{{ percent(memoryPercent) }}</dd>
    </div>
    <div class="topbar-network">
      <div>
        <dt class="sr-only">上传速率</dt>
        <dd data-testid="topbar-metric-tx">
          <span class="topbar-network-arrow" aria-hidden="true">↑</span>
          <span class="topbar-network-value">{{ uploadRate.value }}</span>
          <span class="topbar-network-unit">{{ uploadRate.unit }}</span>
        </dd>
      </div>
      <div>
        <dt class="sr-only">下载速率</dt>
        <dd data-testid="topbar-metric-rx">
          <span class="topbar-network-arrow" aria-hidden="true">↓</span>
          <span class="topbar-network-value">{{ downloadRate.value }}</span>
          <span class="topbar-network-unit">{{ downloadRate.unit }}</span>
        </dd>
      </div>
    </div>
  </dl>
</template>
