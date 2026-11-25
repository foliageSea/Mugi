<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type Component } from 'vue'
import {
  ArrowLeft,
  Bluetooth,
  ChevronDown,
  House,
  LockKeyhole,
  Minus,
  MonitorOff,
  Plane,
  Plus,
  Power,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  SquareStack,
  Sun,
  Wifi,
} from '@lucide/vue'
import {
  AccordionContent,
  AccordionHeader,
  AccordionItem,
  AccordionRoot,
  AccordionTrigger,
} from 'reka-ui'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Slider } from '@/components/ui/slider'
import { errorText } from '@/services/api'
import {
  operate,
  parseControlState,
  type DeviceControlState,
  type Operation,
} from '@/services/workbench'
import ConfirmOperation from './ConfirmOperation.vue'

type ScreenAction = 'wake' | 'off' | 'lock'
const props = defineProps<{
  serial: string
  deviceName: string
  contextKey: string
  connected: boolean
  canTurnOff: boolean
  screenAction: (action: ScreenAction, signal?: AbortSignal) => Promise<boolean>
}>()
const emit = defineEmits<{ reboot: [contextKey: string] }>()

type VolumeOperation = 'volume-down' | 'volume-up'
type NetworkOperation = 'wifi' | 'bluetooth' | 'airplane'
type DeviceCommand = {
  operation: Exclude<Operation, 'device-info' | 'control-state'>
  label: string
  value?: string
}
type Command = DeviceCommand | { screen: ScreenAction; label: string }
type Connection = {
  operation: 'wifi' | 'bluetooth' | 'airplane'
  label: string
  icon: Component
  settings?: DeviceCommand['operation']
  confirmEnable?: string
  confirmDisable?: string
}
const connections: Connection[] = [
  {
    operation: 'wifi',
    label: 'Wi-Fi',
    icon: Wifi,
    settings: 'wifi-settings',
    confirmDisable: '关闭 Wi-Fi 可能中断无线 ADB 连接。',
  },
  { operation: 'bluetooth', label: '蓝牙', icon: Bluetooth, settings: 'bluetooth-settings' },
  {
    operation: 'airplane',
    label: '飞行模式',
    icon: Plane,
    confirmEnable: '飞行模式可能中断无线 ADB 和手机网络连接。',
  },
]
const quickGroups: { label: string; actions: (Command & { icon: Component })[] }[] = [
  {
    label: '导航',
    actions: [
      { operation: 'back', label: '返回', icon: ArrowLeft },
      { operation: 'home', label: '主屏幕', icon: House },
      { operation: 'recents', label: '最近任务', icon: SquareStack },
    ],
  },
  {
    label: '屏幕',
    actions: [
      { screen: 'wake', label: '唤醒屏幕', icon: Sun },
      { screen: 'off', label: '熄灭屏幕', icon: MonitorOff },
      { screen: 'lock', label: '锁屏', icon: LockKeyhole },
    ],
  },
]
const extraCommands: DeviceCommand[] = [
  { operation: 'rotation', value: '0', label: '竖屏' },
  { operation: 'rotation', value: '1', label: '横屏' },
  { operation: 'auto-rotation', label: '自动旋转' },
  { operation: 'stay-awake', value: 'true', label: '充电常亮' },
  { operation: 'stay-awake', value: 'false', label: '关闭常亮' },
  { operation: 'settings', label: '系统设置' },
  { operation: 'power', label: '电源键' },
  { operation: 'reboot', label: '重启设备' },
]

const open = ref(false)
const confirmOpen = ref(false)
const busy = ref('')
const busyOperation = ref<Operation | ScreenAction>()
const error = ref('')
const announcement = ref('')
const reading = ref(false)
const readError = ref('')
const state = ref<DeviceControlState | null>(null)
const brightnessDraft = ref(128)
const volumeFeedback = ref('')
const volumeText = computed(() => {
  if (reading.value) return '读取中…'
  const volume = state.value?.volume
  return volume ? volume.level + ' / ' + volume.max : '音量未知'
})
const volumeFill = computed(() => {
  const volume = state.value?.volume
  return !volume || volume.max === volume.min
    ? 0
    : (volume.level - volume.min) / (volume.max - volume.min)
})
const autoBrightnessTitle = computed(() => {
  if (state.value?.autoBrightness === true) return '自动亮度已开启；拖动滑块可改为手动亮度'
  if (state.value?.autoBrightness === false) return '自动亮度已关闭；点击开启'
  return '自动亮度状态未知；点击开启'
})
let brightnessRevision = 0
let queuedBrightness: number | undefined
const brightnessDisabled = computed(
  () =>
    reading.value || (!!busy.value && busyOperation.value !== 'brightness') || confirmOpen.value,
)
const wifiText = computed(() => {
  if (reading.value) return '读取中…'
  if (state.value?.wifi === true) {
    if (state.value.wifiConnected === true) return '已连接'
    if (state.value.wifiConnected === false) return '未连接'
  }
  return switchText(state.value?.wifi)
})
function switchText(value: boolean | null | undefined) {
  return reading.value
    ? '读取中…'
    : value === true
      ? '已开启'
      : value === false
        ? '已关闭'
        : '状态未知'
}

const deviceContext = () => ({ key: props.contextKey, serial: props.serial })
type DeviceContext = ReturnType<typeof deviceContext>
function isCurrent(target: DeviceContext) {
  return props.connected && target.key === props.contextKey && target.serial === props.serial
}
let readController: AbortController | undefined
let write: { controller: AbortController; promise?: Promise<void> } | undefined
let pending: { target: DeviceContext; command: DeviceCommand } | undefined
const confirmation = ref<{ title: string; description: string }>()
watch(confirmOpen, (isOpen) => {
  if (!isOpen) pending = undefined
})

function emptyState(): DeviceControlState {
  return {
    wifi: null,
    wifiConnected: null,
    bluetooth: null,
    airplane: null,
    brightness: null,
    autoBrightness: null,
    volume: null,
  }
}
async function sample(target: DeviceContext, signal: AbortSignal) {
  return parseControlState(await operate(target.serial, 'control-state', '', signal))
}
async function readControls() {
  const target = deviceContext()
  if (!open.value || !isCurrent(target) || reading.value) return
  const controller = new AbortController()
  readController = controller
  const validRead = () => readController === controller && open.value && isCurrent(target)
  reading.value = true
  readError.value = ''
  error.value = ''
  volumeFeedback.value = ''
  try {
    await write?.promise
    if (!validRead()) return
    const data = await sample(
      target,
      AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]),
    )
    if (!validRead()) return
    state.value = data
    brightnessDraft.value = data.brightness ?? 128
  } catch (cause) {
    if (validRead()) {
      state.value = null
      readError.value = '读取设备状态失败：' + errorText(cause)
    }
  } finally {
    if (validRead()) {
      readController = undefined
      reading.value = false
    }
  }
}

watch(
  open,
  (isOpen) => {
    if (isOpen) {
      if (!props.connected || !props.serial) {
        open.value = false
        return
      }
      error.value = ''
      announcement.value = ''
      void readControls()
      return
    }
    readController?.abort()
    readController = undefined
    reading.value = false
    readError.value = ''
    state.value = null
    brightnessDraft.value = 128
    volumeFeedback.value = ''
    queuedBrightness = undefined
    pending = undefined
    confirmOpen.value = false
  },
  { flush: 'sync' },
)

function invalidate() {
  if (!props.connected && open.value && busyOperation.value && isNetwork(busyOperation.value)) {
    toast.warning(busy.value + '：连接已断开，无法确认状态。')
  }
  open.value = false
  write?.controller.abort()
  write = undefined
  busy.value = ''
  busyOperation.value = undefined
  error.value = ''
  announcement.value = ''
}
watch(() => [props.contextKey, props.serial, props.connected] as const, invalidate)
onBeforeUnmount(invalidate)

function canWrite() {
  return open.value && props.connected && !!props.serial && !write && !confirmOpen.value
}
function isNetwork(operation: string): operation is NetworkOperation {
  return operation === 'wifi' || operation === 'bluetooth' || operation === 'airplane'
}
function isVolume(operation: Operation): operation is VolumeOperation {
  return operation === 'volume-down' || operation === 'volume-up'
}
function patchState(patch: Partial<DeviceControlState>) {
  state.value = { ...(state.value ?? emptyState()), ...patch }
}
function clearNetwork(operation: NetworkOperation) {
  if (operation === 'airplane')
    patchState({ airplane: null, wifi: null, wifiConnected: null, bluetooth: null })
  else if (operation === 'wifi') patchState({ wifi: null, wifiConnected: null })
  else patchState({ bluetooth: null })
}

function run(command: Command) {
  if (!canWrite() || ('screen' in command && command.screen === 'off' && !props.canTurnOff)) return
  const target = deviceContext()
  const controller = new AbortController()
  const job: NonNullable<typeof write> = { controller }
  const operation = 'operation' in command ? command.operation : undefined
  const volume = operation && isVolume(operation) ? operation : undefined
  const previousVolume = state.value?.volume
  const revision = brightnessRevision
  if (volume) volumeFeedback.value = ''
  write = job
  busy.value = command.label
  busyOperation.value = 'screen' in command ? command.screen : command.operation
  error.value = ''
  announcement.value = ''
  const validWrite = () => write === job && !controller.signal.aborted && isCurrent(target)
  const visibleWrite = () => validWrite() && open.value

  job.promise = (async () => {
    let sent = false
    try {
      if ('screen' in command) {
        if (!(await props.screenAction(command.screen, controller.signal)))
          throw new Error('设备未执行此操作')
      } else {
        await operate(target.serial, command.operation, command.value, controller.signal)
        sent = true
        if (!validWrite()) return
        if (command.operation === 'reboot') {
          open.value = false
          emit('reboot', target.key)
          return
        }
        if (!open.value) return
        if (isNetwork(command.operation)) {
          const network = command.operation
          const enabled = command.value === 'enable'
          let data: DeviceControlState | undefined
          // Android radio transitions may outlast the command. Never infer the resulting state.
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3500)])
          for (const delay of [0, 200, 500, 800]) {
            if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
            if (!visibleWrite() || signal.aborted) break
            data = await sample(target, signal)
            if (data[network] === enabled) break
          }
          if (!visibleWrite()) return
          if (!data || data[network] === null) throw new Error('设备没有返回可确认的状态')
          const { wifi, wifiConnected, bluetooth, airplane } = data
          patchState({ wifi, wifiConnected, bluetooth, airplane })
          if (data[network] !== enabled) {
            error.value = command.label + '未生效，已显示设备回读的状态。'
            return
          }
        } else if (volume) {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3500)])
          let actual: DeviceControlState['volume'] = null
          let changed = false
          for (const delay of [120, 240, 450]) {
            await new Promise((resolve) => setTimeout(resolve, delay))
            if (!visibleWrite() || signal.aborted) break
            const data = await sample(target, signal)
            actual = data.volume ?? actual
            if (!actual) continue
            changed = previousVolume != null && actual.level !== previousVolume.level
            if (changed || !previousVolume) break
          }
          if (!visibleWrite()) return
          if (!actual) throw new Error('设备没有返回媒体音量')
          patchState({ volume: actual })
          if (!changed && previousVolume) {
            if (
              (volume === 'volume-up' && actual.level === actual.max) ||
              (volume === 'volume-down' && actual.level === actual.min)
            )
              volumeFeedback.value = '已到音量边界'
            else volumeFeedback.value = '媒体音量未变化'
          }
        } else if (operation === 'brightness' || operation === 'auto-brightness') {
          const manual = operation === 'brightness'
          if (manual && queuedBrightness !== undefined) return
          const data = await sample(
            target,
            AbortSignal.any([controller.signal, AbortSignal.timeout(3500)]),
          )
          if (!visibleWrite()) return
          patchState({ brightness: data.brightness, autoBrightness: data.autoBrightness })
          if (manual && data.brightness !== null && revision === brightnessRevision)
            brightnessDraft.value = data.brightness
          if (manual && (data.brightness === null || data.autoBrightness === true))
            throw new Error('设备没有返回可确认的手动亮度')
          if (manual && queuedBrightness === undefined && data.brightness !== Number(command.value))
            error.value = '设备未达到目标亮度，已显示实际亮度。'
          if (!manual && data.autoBrightness !== true) throw new Error('设备没有确认自动亮度已开启')
          readError.value = ''
        }
      }
      if (visibleWrite() && !error.value)
        announcement.value = volume
          ? volumeFeedback.value || '已发送：' + command.label
          : '已执行：' + command.label
    } catch (cause) {
      if (!visibleWrite()) return
      if (operation && isNetwork(operation)) clearNetwork(operation)
      if (volume) {
        if (sent) patchState({ volume: null })
        volumeFeedback.value = sent
          ? '未能回读媒体音量'
          : command.label + '失败：' + errorText(cause)
        return
      }
      if (sent && (operation === 'brightness' || operation === 'auto-brightness'))
        patchState({ brightness: null, autoBrightness: null })
      if (operation === 'brightness' && !sent && revision === brightnessRevision)
        brightnessDraft.value = state.value?.brightness ?? 128
      error.value =
        command.label + (sent ? '请求已发送，未能确认状态：' : '失败：') + errorText(cause)
    } finally {
      if (write === job) {
        write = undefined
        busy.value = ''
        busyOperation.value = undefined
        drainBrightness()
      }
    }
  })()
}

function updateBrightness(values: number[] | undefined) {
  const value = values?.[0]
  if (value !== undefined && value !== brightnessDraft.value) {
    brightnessDraft.value = value
    brightnessRevision++
  }
}
function commitBrightness(values: number[]) {
  const value = values[0]
  if (value === undefined || brightnessDisabled.value) return
  updateBrightness(values)
  queuedBrightness = value
  drainBrightness()
}
function drainBrightness() {
  if (!canWrite() || queuedBrightness === undefined) return
  const value = queuedBrightness
  queuedBrightness = undefined
  run({ operation: 'brightness', value: String(value), label: '设置亮度' })
}

function confirmCommand(event: MouseEvent, command: DeviceCommand, description: string) {
  if (!canWrite()) return
  // Preserve the origin even on browsers that don't focus buttons on pointer click.
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus({ preventScroll: true })
  pending = { command, target: deviceContext() }
  confirmation.value = { title: command.label, description }
  confirmOpen.value = true
}

function runConfirmed() {
  const request = pending
  pending = undefined
  if (request && isCurrent(request.target)) run(request.command)
}

function switchConnection(event: MouseEvent, connection: Connection) {
  const current = state.value?.[connection.operation]
  if (typeof current !== 'boolean' || reading.value) return
  const enabled = !current
  const command: DeviceCommand = {
    operation: connection.operation,
    label: (enabled ? '开启 ' : '关闭 ') + connection.label,
    value: enabled ? 'enable' : 'disable',
  }
  const description = enabled ? connection.confirmEnable : connection.confirmDisable
  if (description) confirmCommand(event, command, description)
  else run(command)
}

function setAutoBrightness() {
  if (!reading.value && !busy.value && state.value?.autoBrightness !== true)
    run({ operation: 'auto-brightness', label: '自动亮度' })
}

function runExtraCommand(event: MouseEvent, command: DeviceCommand) {
  if (command.operation !== 'reboot') {
    run(command)
    return
  }
  confirmCommand(
    event,
    command,
    '即将重启 ' + (props.deviceName || props.serial) + '，投屏和终端连接会断开。',
  )
}

async function focusTitle(event: Event) {
  const panel = event.target
  if (!(panel instanceof HTMLElement)) return
  event.preventDefault()
  await nextTick()
  if (open.value && panel.isConnected) {
    panel.querySelector<HTMLElement>('.control-center-title')?.focus({ preventScroll: true })
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="控制中心"
        title="控制中心"
        :disabled="!connected || !serial"
      >
        <SlidersHorizontal class="size-4" aria-hidden="true" />
      </Button>
    </DialogTrigger>

    <DialogContent
      variant="control-center"
      class="device-control-center"
      :show-close-button="false"
      @open-auto-focus="focusTitle"
    >
      <header class="control-center-header">
        <div class="control-center-identity">
          <DialogTitle class="control-center-title" tabindex="-1">控制中心</DialogTitle>
          <DialogDescription class="control-center-device" :title="deviceName || serial">
            {{ deviceName || serial }}
          </DialogDescription>
        </div>
        <button
          type="button"
          class="control-center-header-button"
          aria-label="刷新状态"
          title="刷新状态"
          :disabled="reading || !!busy"
          @click="readControls"
        >
          <RefreshCw aria-hidden="true" :class="{ 'motion-safe:animate-spin': reading }" />
        </button>
      </header>
      <p v-if="error" role="alert" class="control-center-error">{{ error }}</p>
      <p role="status" class="sr-only">
        {{ busy ? '正在执行：' + busy : volumeFeedback ? '' : announcement }}
      </p>

      <div class="control-center-scroll">
        <div class="control-center-primary">
          <div class="control-center-connectivity" role="group" aria-label="连接">
            <div
              v-for="connection in connections"
              :key="connection.operation"
              class="control-center-network"
              :data-active="state?.[connection.operation] === true"
            >
              <button
                type="button"
                class="control-center-tile"
                :role="typeof state?.[connection.operation] === 'boolean' ? 'switch' : undefined"
                :aria-label="connection.label"
                :aria-checked="state?.[connection.operation] ?? undefined"
                :aria-disabled="
                  reading || !!busy || typeof state?.[connection.operation] !== 'boolean'
                "
                @click="switchConnection($event, connection)"
              >
                <span class="control-center-tile-icon">
                  <component :is="connection.icon" aria-hidden="true" />
                </span>
                <span class="control-center-tile-copy">
                  <span>{{ connection.label }}</span>
                  <small>
                    {{
                      busyOperation === connection.operation
                        ? '确认中…'
                        : connection.operation === 'wifi'
                          ? wifiText
                          : switchText(state?.[connection.operation])
                    }}
                  </small>
                </span>
              </button>
              <button
                v-if="connection.settings"
                type="button"
                class="control-center-tile-settings"
                :aria-label="connection.label + ' 设置'"
                :title="connection.label + ' 设置'"
                :aria-disabled="!!busy"
                @click="run({ operation: connection.settings, label: connection.label + ' 设置' })"
              >
                <Settings aria-hidden="true" />
              </button>
            </div>
          </div>

          <div class="control-center-levels">
            <div class="control-center-level" role="group" aria-label="屏幕亮度">
              <div class="control-center-level-heading">
                <span class="control-center-level-label">亮度</span>
                <span class="control-center-level-value">
                  {{
                    reading
                      ? '读取中…'
                      : state?.brightness == null && busyOperation !== 'brightness'
                        ? '亮度未知'
                        : brightnessDraft + ' / 255'
                  }}
                </span>
              </div>
              <div class="control-center-level-track">
                <Sun class="control-center-level-icon" aria-hidden="true" />
                <Slider
                  :model-value="[brightnessDraft]"
                  orientation="horizontal"
                  :min="0"
                  :max="255"
                  :step="1"
                  :disabled="brightnessDisabled"
                  class="control-center-slider"
                  aria-label="屏幕亮度"
                  :aria-valuetext="
                    !reading && state?.brightness == null && busyOperation !== 'brightness'
                      ? '亮度未知'
                      : undefined
                  "
                  @update:model-value="updateBrightness"
                  @value-commit="commitBrightness"
                />
                <button
                  type="button"
                  class="control-center-level-button"
                  aria-label="自动亮度"
                  :aria-pressed="state?.autoBrightness ?? undefined"
                  :aria-disabled="reading || !!busy || state?.autoBrightness === true"
                  :title="autoBrightnessTitle"
                  @click="setAutoBrightness"
                >
                  <Sun aria-hidden="true" />
                  <span aria-hidden="true">A</span>
                </button>
              </div>
            </div>
            <div class="control-center-level" role="group" aria-label="媒体音量">
              <div class="control-center-level-heading">
                <span class="control-center-level-label">媒体音量</span>
                <span class="control-center-level-value">{{ volumeText }}</span>
              </div>
              <div class="control-center-level-track">
                <button
                  type="button"
                  class="control-center-level-button"
                  aria-label="调低音量"
                  title="调低音量"
                  :aria-disabled="!!busy"
                  @click="run({ operation: 'volume-down', label: '调低音量' })"
                >
                  <Minus aria-hidden="true" />
                </button>
                <span class="control-center-volume-meter" aria-hidden="true">
                  <span :style="{ width: volumeFill * 100 + '%' }" />
                </span>
                <button
                  type="button"
                  class="control-center-level-button"
                  aria-label="调高音量"
                  title="调高音量"
                  :aria-disabled="!!busy"
                  @click="run({ operation: 'volume-up', label: '调高音量' })"
                >
                  <Plus aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </div>
        <p v-if="volumeFeedback" class="control-center-volume-feedback" role="status">
          {{ volumeFeedback }}
        </p>
        <div v-if="readError" class="control-center-feedback">
          <p role="alert" class="control-center-error">{{ readError }}</p>
          <button
            type="button"
            class="control-center-command"
            :disabled="reading || !!busy"
            @click="readControls"
          >
            重试
          </button>
        </div>

        <div class="control-center-groups">
          <div
            v-for="group in quickGroups"
            :key="group.label"
            role="group"
            :aria-label="group.label"
            class="control-center-group"
          >
            <button
              v-for="action in group.actions"
              :key="action.label"
              type="button"
              class="control-center-action"
              :disabled="'screen' in action && action.screen === 'off' && !canTurnOff"
              :aria-disabled="!!busy"
              @click="run(action)"
            >
              <component :is="action.icon" aria-hidden="true" />
              {{ action.label }}
            </button>
          </div>
        </div>

        <AccordionRoot type="single" collapsible class="control-center-more">
          <AccordionItem value="more">
            <AccordionHeader as="h3">
              <AccordionTrigger class="control-center-more-trigger">
                <Settings aria-hidden="true" />
                更多控制
                <ChevronDown class="control-center-chevron" aria-hidden="true" />
              </AccordionTrigger>
            </AccordionHeader>
            <AccordionContent class="control-center-more-content">
              <button
                v-for="action in extraCommands"
                :key="action.label"
                type="button"
                class="control-center-command"
                :class="{ 'control-center-reboot': action.operation === 'reboot' }"
                :aria-disabled="!!busy"
                @click="runExtraCommand($event, action)"
              >
                {{ action.label }}
              </button>
            </AccordionContent>
          </AccordionItem>
        </AccordionRoot>
      </div>

      <ConfirmOperation
        v-model:open="confirmOpen"
        :title="confirmation?.title || ''"
        :description="confirmation?.description || ''"
        @confirm="runConfirmed"
      />
    </DialogContent>
  </Dialog>
</template>

<style scoped>
/* DialogContent is portalled and its root does not inherit this component's scope attribute. */
:global(.device-control-center) {
  --cc-tile: #2b3547;
  --cc-deep: #222b3a;
  --cc-line: light-dark(color-mix(in srgb, var(--foreground) 18%, transparent), #b9d3ff22);
  --cc-muted: light-dark(color-mix(in srgb, var(--foreground) 76%, transparent), #b8c4d8);
  --cc-accent: light-dark(var(--primary), #b4d3ff);
  --cc-danger: light-dark(var(--destructive), #ffb8bd);
  --cc-track: #55555d;
  --cc-track-shadow: inset 0 1px 2px #0004, 0 0 0 1px #ffffff26;
  --cc-fill: #e8e8ed;
  --cc-thumb-border: #54545c;
  --cc-thumb: #fff;
}
.device-control-center {
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow: hidden;
  padding: 0;
  border-radius: 24px;
  color: light-dark(var(--foreground), #f3f6ff);
  box-shadow:
    0 22px 64px light-dark(var(--glass-shadow), #0008),
    0 4px 18px light-dark(color-mix(in srgb, var(--glass-shadow) 65%, transparent), #0006);
}
:global(.light .device-control-center) {
  --cc-track: #c2c8d0;
  --cc-track-shadow: inset 0 1px 2px #26334826;
  --cc-fill: #1760ba;
  --cc-thumb-border: #586577;
}
.control-center-header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 14px 8px;
}
.control-center-identity {
  min-width: 0;
}
.control-center-title {
  font-size: 17px;
  font-weight: 650;
  outline: none;
}
.control-center-device {
  overflow: hidden;
  color: var(--cc-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.control-center-header-button,
.control-center-tile-icon {
  display: grid;
  flex: none;
  place-items: center;
  border-radius: 50%;
}
.control-center-header-button {
  width: 34px;
  height: 34px;
  color: var(--cc-muted);
}
.control-center-reboot {
  color: var(--cc-danger);
}
.control-center-scroll {
  display: grid;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  align-content: start;
  gap: 8px;
  overflow: hidden auto;
  overscroll-behavior: contain;
  padding: 2px 14px 14px;
}
.control-center-primary {
  display: grid;
  min-width: 0;
  gap: 10px;
}
.control-center-connectivity,
.control-center-groups {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.control-center-connectivity {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.control-center-network {
  display: flex;
  min-width: 0;
  min-height: 46px;
  align-items: stretch;
  border: 1px solid transparent;
  border-radius: 12px;
}
.control-center-network[data-active='true'] {
  border-color: light-dark(color-mix(in srgb, var(--primary) 40%, transparent), #83b5fb6b);
  background: light-dark(color-mix(in srgb, var(--primary) 14%, transparent), #344e74);
}
.control-center-tile {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  text-align: start;
}
.control-center-tile-copy {
  display: grid;
  min-width: 0;
  gap: 1px;
  line-height: 1.2;
}
.control-center-tile-copy small {
  color: var(--cc-muted);
  font-size: 11px;
  font-weight: 450;
  white-space: nowrap;
}
.control-center-tile-icon {
  width: 24px;
  height: 24px;
  background: light-dark(color-mix(in srgb, var(--primary) 10%, transparent), #151e2e70);
  color: var(--cc-accent);
}
.control-center-network[data-active='true'] .control-center-tile-icon {
  background: light-dark(var(--primary), #9fc9ff);
  color: light-dark(#fff, #10294a);
}
.control-center-tile-settings {
  display: grid;
  width: 28px;
  flex: none;
  place-items: center;
  border-radius: 10px;
  color: var(--cc-muted);
}
.device-control-center button svg,
.control-center-level-icon {
  width: 16px;
  height: 16px;
  flex: none;
}
.device-control-center button .control-center-chevron {
  width: 14px;
  height: 14px;
  color: var(--cc-muted);
}
.control-center-more-trigger[data-state='open'] .control-center-chevron {
  transform: rotate(180deg);
}
.control-center-levels {
  display: grid;
  min-width: 0;
  row-gap: 16px;
  padding: 8px 3px 0;
  border-top: 1px solid var(--cc-line);
}
.control-center-level {
  display: grid;
  min-width: 0;
  row-gap: 8px;
}
.control-center-level-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.control-center-level-label {
  font-size: 12px;
  font-weight: 650;
}
.control-center-level-value {
  color: var(--cc-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.control-center-level-track {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) 32px;
  align-items: center;
  gap: 6px;
}
.control-center-level-icon {
  justify-self: center;
  color: var(--cc-accent);
}
.control-center-level-button {
  position: relative;
  display: grid;
  min-height: 32px;
  place-items: center;
  border-radius: 8px;
  color: var(--cc-accent);
}
.control-center-level-button span {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  color: currentColor;
  font-size: 8px;
  font-weight: 800;
  pointer-events: none;
}
.device-control-center .control-center-level-button:has(span) svg {
  width: 20px;
  height: 20px;
}
.control-center-level-button svg :deep(circle) {
  stroke: none;
}
.device-control-center .control-center-level-button[aria-pressed='true'] {
  color: light-dark(color-mix(in srgb, var(--primary) 78%, black), #b6d8ff);
  opacity: 1;
}
.control-center-volume-meter,
.control-center-slider :deep([data-slot='slider-track']) {
  height: 8px;
  border-radius: 999px;
  background: var(--cc-track);
  box-shadow: var(--cc-track-shadow);
}
.control-center-volume-meter {
  display: flex;
  width: 100%;
  overflow: hidden;
}
.control-center-volume-meter span {
  border-radius: inherit;
  background: var(--cc-fill);
  transition: width 140ms ease-out;
}
@media (prefers-reduced-motion: reduce) {
  .control-center-volume-meter span {
    transition: none;
  }
}
.control-center-volume-feedback {
  padding: 0 4px;
  color: var(--cc-muted);
  font-size: 12px;
  text-align: end;
  overflow-wrap: anywhere;
}
.control-center-slider[data-orientation='horizontal'] {
  min-width: 0;
  min-height: 26px;
}
.control-center-slider :deep([data-slot='slider-range']) {
  border-radius: inherit;
  background: var(--cc-fill);
}
.control-center-slider :deep([data-slot='slider-thumb']) {
  width: 16px;
  height: 16px;
  border-color: var(--cc-thumb-border);
  background: var(--cc-thumb);
  box-shadow: 0 1px 3px #0005;
}
.control-center-slider :deep([data-slot='slider-thumb']:focus-visible) {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
.control-center-feedback {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.control-center-feedback {
  justify-content: flex-end;
}
.control-center-feedback .control-center-error {
  min-width: 0;
  flex: 1 0 140px;
  margin: 0;
}
.control-center-command {
  min-height: 32px;
  max-width: 100%;
  padding: 4px 7px;
  border-radius: 9px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.control-center-group {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 3px;
}
.control-center-groups {
  gap: 2px;
  padding-top: 5px;
  border-top: 1px solid var(--cc-line);
}
.control-center-action,
.control-center-more-trigger {
  display: flex;
  min-height: 38px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 4px;
  border-radius: 11px;
  font-size: 12px;
  line-height: 1.2;
}
.control-center-group .control-center-action {
  min-width: 0;
}
.control-center-more {
  border-top: 1px solid var(--cc-line);
}
.control-center-action svg,
.control-center-more-trigger svg {
  color: var(--cc-accent);
}
.control-center-more-trigger {
  width: 100%;
  justify-content: flex-start;
  padding: 0 10px;
}
.control-center-more-trigger .control-center-chevron {
  margin-inline-start: auto;
}
.control-center-more-content:not([hidden]) {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 5px;
  padding: 0 7px 7px;
}
.control-center-more-content .control-center-command {
  min-height: 29px;
  padding-inline: 3px;
  font-size: 11px;
}
.control-center-error {
  flex: none;
  max-height: 64px;
  overflow: auto;
  margin: 0 14px 5px;
  padding: 6px 9px;
  border: 1px solid light-dark(color-mix(in srgb, var(--destructive) 45%, transparent), #ff9da66a);
  border-radius: 10px;
  color: var(--cc-danger);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.device-control-center button:focus-visible {
  outline: 2px solid var(--cc-accent);
  outline-offset: -2px;
}
.device-control-center button:disabled,
.device-control-center button[aria-disabled='true'] {
  cursor: not-allowed;
  opacity: 0.58;
}
@media (hover: hover) {
  .control-center-tile:not([aria-disabled='true']):hover,
  .control-center-tile-settings:not([aria-disabled='true']):hover,
  .control-center-level-button:not([aria-disabled='true']):hover,
  .control-center-header-button:not(:disabled, [aria-disabled='true']):hover,
  .control-center-command:not([aria-disabled='true']):hover,
  .control-center-group .control-center-action:not(:disabled, [aria-disabled='true']):hover,
  .control-center-more-trigger:hover {
    background: light-dark(color-mix(in srgb, var(--primary) 12%, transparent), #b8d5ff24);
  }
  .control-center-reboot:not([aria-disabled='true']):hover {
    background: color-mix(in srgb, var(--cc-danger) 12%, transparent);
  }
}
@media (max-width: 360px) {
  .control-center-header,
  .control-center-scroll {
    padding-inline: 10px;
  }
  .control-center-tile {
    gap: 4px;
    padding-inline: 4px;
    font-size: 12px;
  }
  .control-center-tile-icon {
    width: 20px;
    height: 20px;
  }
  .control-center-tile-settings {
    width: 24px;
  }
  .control-center-action {
    gap: 3px;
  }
}
</style>
