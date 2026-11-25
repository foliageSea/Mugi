<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { BatteryMedium, ChevronDown, Cpu, HardDrive, RefreshCw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import DockIcon from './DockIcon.vue'
import WindowFrame from './WindowFrame.vue'
import { errorText } from '@/services/api'
import { formatBytes } from '@/services/files'
import { operate, parseDeviceInfo, type DeviceDetails } from '@/services/workbench'

const props = defineProps<{ serial: string; deviceName: string }>()
const emit = defineEmits<{ close: [] }>()

const details = shallowRef<DeviceDetails>()
const request = shallowRef<AbortController>()
const loading = computed(() => !!request.value)
const infoError = ref('')
const properties = computed(() => details.value?.properties ?? {})
const model = computed(() => properties.value['ro.product.model'] || props.deviceName)
const release = computed(() => properties.value['ro.build.version.release'])
const sdk = computed(() => properties.value['ro.build.version.sdk'])
const storage = computed(() => details.value?.storage ?? [])
const primaryStorage = computed(
  () => storage.value.find((disk) => disk.path === '/data') ?? storage.value[0],
)
const battery = computed(() => details.value?.battery)
const storageAvailability = computed(() => {
  const disk = primaryStorage.value
  return disk && disk.total > 0 ? (disk.available / disk.total) * 100 : null
})

function gaugeWidth(value: number) {
  return Math.min(100, Math.max(0, value)) + '%'
}

const versionRows = computed(() => {
  const p = properties.value
  return [
    ['品牌 / 代号', [p['ro.product.brand'], p['ro.product.device']].filter(Boolean).join(' / ')],
    ['系统版本', p['ro.build.display.id']],
    ['安全补丁', p['ro.build.version.security_patch']],
    ['CPU 架构', p['ro.product.cpu.abilist']],
    [
      'Bootloader 锁定',
      p['ro.boot.flash.locked'] === '1' ? '是' : p['ro.boot.flash.locked'] === '0' ? '否' : '',
    ],
  ]
})
const statusRows = computed(() => {
  const uptime = details.value?.uptime
  const power = battery.value?.power
  return [
    ['屏幕', details.value?.display],
    [
      '运行时间',
      uptime == null
        ? ''
        : `${Math.floor(uptime / 3600)} 小时 ${Math.floor((uptime % 3600) / 60)} 分钟`,
    ],
    ['网络地址', details.value?.network],
    ['前台应用', details.value?.foreground],
    ['ADB 身份 / SELinux', details.value?.security],
    ['电池状态', [battery.value?.status, power === '—' ? '' : power].filter(Boolean).join(' · ')],
  ]
})

async function refresh() {
  const serial = props.serial
  if (loading.value || !serial) return
  const controller = new AbortController()
  request.value = controller
  try {
    const output = await operate(serial, 'device-info', '', controller.signal)
    if (controller.signal.aborted || serial !== props.serial) return
    // The parser tolerates individual unavailable fields, but don't replace a good snapshot with an incomplete response.
    if (!/^__PROPERTIES__\r?$/m.test(output) || !/^__END__\r?$/m.test(output)) {
      throw new Error('设备返回的信息不完整')
    }
    details.value = parseDeviceInfo(output)
    infoError.value = ''
  } catch (cause) {
    if (!controller.signal.aborted && serial === props.serial) infoError.value = errorText(cause)
  } finally {
    if (request.value === controller) request.value = undefined
  }
}

function cancelRefresh() {
  request.value?.abort()
  request.value = undefined
}

watch(
  () => props.serial,
  () => {
    cancelRefresh()
    details.value = undefined
    infoError.value = ''
    void refresh()
  },
  { immediate: true },
)
onBeforeUnmount(cancelRefresh)
</script>

<template>
  <WindowFrame
    id="device-tools"
    title="关于设备"
    :geometry="{
      size: { width: 780, height: 640 },
      minSize: { width: 420, height: 400 },
      titlebarHeight: 44,
      mobileFullscreen: true,
    }"
    @close="emit('close')"
  >
    <div class="device-about-scroll">
      <div class="device-about-content">
        <header class="device-about-hero">
          <DockIcon name="device" class="device-about-emblem" />
          <div class="device-about-identity">
            <h2>{{ model }}</h2>
            <p v-if="serial">
              序列号
              <code>{{ serial }}</code>
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            class="device-about-refresh"
            :disabled="loading || !serial"
            @click="refresh"
          >
            <RefreshCw aria-hidden="true" :class="{ 'motion-safe:animate-spin': loading }" />
            刷新信息
          </Button>
        </header>

        <div v-if="infoError" class="device-about-feedback">
          <p role="alert">{{ infoError }}</p>
          <Button type="button" variant="outline" size="sm" :disabled="loading" @click="refresh">
            重试
          </Button>
        </div>
        <p role="status" class="device-about-loading" :class="{ 'sr-only': !!details || !loading }">
          {{ loading ? '正在读取设备信息…' : '' }}
        </p>

        <div v-if="details" :aria-busy="loading">
          <dl class="device-about-specs">
            <div class="device-about-spec">
              <dt>
                <Cpu aria-hidden="true" />
                系统
              </dt>
              <dd>
                <strong>Android {{ release || '—' }}</strong>
                <span class="device-about-note">API {{ sdk || '—' }}</span>
              </dd>
            </div>
            <div class="device-about-spec">
              <dt>
                <HardDrive aria-hidden="true" />
                <span>存储</span>
                <code v-if="primaryStorage">{{ primaryStorage.path }}</code>
              </dt>
              <dd v-if="primaryStorage">
                <span class="device-about-metric">
                  <strong>{{ formatBytes(primaryStorage.available) }}</strong>
                  <span class="device-about-note">可用</span>
                </span>
                <span class="device-about-note device-about-metric">
                  <span>总容量</span>
                  <span>{{ formatBytes(primaryStorage.total) }}</span>
                </span>
                <span
                  v-if="storageAvailability != null"
                  class="device-about-gauge"
                  aria-hidden="true"
                >
                  <span :style="{ width: gaugeWidth(storageAvailability) }"></span>
                </span>
              </dd>
              <dd v-else><strong>—</strong></dd>
            </div>
            <div class="device-about-spec device-about-spec-battery">
              <dt>
                <BatteryMedium aria-hidden="true" />
                电池
              </dt>
              <dd>
                <strong>{{ battery?.percent == null ? '—' : battery.percent + '%' }}</strong>
                <span class="device-about-note">
                  温度
                  <span>
                    {{ battery?.temperature == null ? '—' : battery.temperature + ' °C' }}
                  </span>
                </span>
                <span v-if="battery?.percent != null" class="device-about-gauge" aria-hidden="true">
                  <span :style="{ width: gaugeWidth(battery.percent) }"></span>
                </span>
              </dd>
            </div>
          </dl>

          <div class="device-about-sections">
            <details class="device-about-section">
              <summary>
                版本信息
                <ChevronDown aria-hidden="true" />
              </summary>
              <dl class="device-about-details">
                <div v-for="[label, value] in versionRows" :key="label">
                  <dt>{{ label }}</dt>
                  <dd>{{ value || '—' }}</dd>
                </div>
              </dl>
            </details>
            <details class="device-about-section">
              <summary>
                状态信息
                <ChevronDown aria-hidden="true" />
              </summary>
              <dl class="device-about-details">
                <div v-for="[label, value] in statusRows" :key="label">
                  <dt>{{ label }}</dt>
                  <dd>{{ value || '—' }}</dd>
                </div>
              </dl>
              <div class="device-about-mounts">
                <h3>存储分区</h3>
                <ul v-if="storage.length">
                  <li v-for="(disk, index) in storage" :key="index">
                    <code>{{ disk.path }}</code>
                    <div class="device-about-mount-values">
                      <span>总容量 {{ formatBytes(disk.total) }}</span>
                      <span>已用 {{ formatBytes(disk.used) }}</span>
                      <span>可用 {{ formatBytes(disk.available) }}</span>
                    </div>
                  </li>
                </ul>
                <p v-else>—</p>
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  </WindowFrame>
</template>

<style scoped>
.device-about-scroll {
  container: device-about / inline-size;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable both-edges;
  background: var(--background);
  color: var(--foreground);
}
.device-about-content {
  --about-gutter: clamp(12px, 3.8cqi, 32px);
  max-width: 880px;
  margin-inline: auto;
  padding: var(--about-gutter) var(--about-gutter) clamp(24px, 5cqi, 40px);
  overflow-wrap: anywhere;
}
.device-about-hero,
.device-about-spec,
.device-about-sections {
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background-color: var(--card);
  color: var(--card-foreground);
}
.device-about-hero {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px clamp(12px, 3cqi, 24px);
  padding: clamp(14px, 4cqi, 30px);
  background-image: linear-gradient(
    110deg,
    color-mix(in srgb, var(--primary) 14%, transparent),
    transparent 82%
  );
}
.device-about-emblem {
  display: block;
  width: clamp(48px, 10cqi, 72px);
  height: auto;
}
.device-about-identity h2 {
  font-size: clamp(24px, 5cqi, 38px);
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.15;
}
.device-about-identity p {
  margin-top: 6px;
  color: var(--muted-foreground);
  font-size: 12px;
}
.device-about-identity code {
  margin-inline-start: 4px;
  color: var(--card-foreground);
}
.device-about-refresh {
  min-height: 36px;
  justify-self: start;
  background: var(--card);
}
.device-about-refresh:hover {
  background: var(--accent);
}
.device-about-feedback {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--destructive) 40%, transparent);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--destructive) 8%, var(--card));
  color: var(--destructive);
}
.device-about-feedback p {
  flex: 1 0 min(100%, 9rem);
  min-width: 0;
  max-height: 5lh;
  overflow: auto;
  white-space: pre-wrap;
}
.device-about-loading {
  margin-top: 14px;
  color: var(--muted-foreground);
}
.device-about-specs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-block: 14px;
}
.device-about-spec {
  --gauge-fill: var(--primary);
  display: grid;
  grid-template-rows: auto 1fr;
  align-items: start;
  gap: 12px;
  padding: clamp(12px, 2.5cqi, 20px);
}
.device-about-spec-battery {
  --gauge-fill: var(--success);
}
.device-about-spec dt {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  min-width: 0;
  color: var(--muted-foreground);
  font-size: 13px;
  font-weight: 550;
}
.device-about-spec dt svg {
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--primary);
}
.device-about-spec dt code {
  margin-inline-start: auto;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--muted);
  font-size: 11px;
  font-weight: 400;
}
.device-about-spec dd {
  display: grid;
  gap: 4px;
  min-width: 0;
  font-variant-numeric: tabular-nums;
}
.device-about-spec strong {
  font-size: clamp(20px, 3.3cqi, 26px);
  font-weight: 650;
  line-height: 1.16;
}
.device-about-metric {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 6px;
}
.device-about-note {
  color: var(--muted-foreground);
  font-size: 12px;
}
.device-about-gauge {
  display: block;
  height: 5px;
  margin-top: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--muted);
}
.device-about-gauge > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--gauge-fill);
}
.device-about-section + .device-about-section {
  border-top: 1px solid var(--border);
}
.device-about-section summary {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-inline: 16px;
  list-style: none;
  cursor: pointer;
  font-weight: 600;
}
.device-about-section:first-child summary {
  border-start-start-radius: calc(var(--radius-xl) - 1px);
  border-start-end-radius: calc(var(--radius-xl) - 1px);
}
.device-about-section:last-child:not([open]) summary {
  border-end-start-radius: calc(var(--radius-xl) - 1px);
  border-end-end-radius: calc(var(--radius-xl) - 1px);
}
.device-about-section summary::-webkit-details-marker {
  display: none;
}
.device-about-section summary:hover {
  background: var(--muted);
}
.device-about-section summary:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -3px;
}
.device-about-section summary svg {
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--muted-foreground);
}
.device-about-section[open] summary svg {
  transform: rotate(180deg);
}
.device-about-details,
.device-about-mounts {
  margin-inline: 16px;
  font-size: 13px;
}
.device-about-details > div {
  display: grid;
  grid-template-columns: minmax(0, clamp(100px, 32%, 180px)) minmax(0, 1fr);
  gap: 10px;
  padding-block: 9px;
  border-top: 1px solid var(--border);
}
.device-about-details dt,
.device-about-mount-values,
.device-about-mounts p {
  color: var(--muted-foreground);
}
.device-about-details dd {
  white-space: pre-wrap;
}
.device-about-mounts {
  padding: 12px 0 16px;
  border-top: 1px solid var(--border);
}
.device-about-mounts h3 {
  margin-bottom: 8px;
  font-weight: 600;
}
.device-about-mounts ul {
  display: grid;
  gap: 6px;
}
.device-about-mounts li {
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--muted);
}
.device-about-mount-values {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
  font-size: 12px;
}
@container device-about (width < 530px) {
  .device-about-hero {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .device-about-refresh {
    grid-column: 2;
  }
  .device-about-specs {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
  .device-about-spec {
    grid-template-columns: minmax(0, 34%) minmax(0, 1fr);
    grid-template-rows: auto;
    align-items: start;
  }
  .device-about-spec dt code {
    margin-inline-start: 0;
  }
}
</style>
