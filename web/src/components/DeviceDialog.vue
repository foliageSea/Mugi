<script setup lang="ts">
import { ref, watch } from 'vue'
import { Smartphone, RefreshCw, Usb, Wifi, Check, LoaderCircle } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, errorText } from '@/services/api'
import { WebUsbConnection } from '@/services/webusb'
import type { Device } from '@/types'
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{
  devices: Device[]
  serial: string
  loading: boolean
  transport: 'adb' | 'webusb'
  usbConnected: boolean
  usbBusy: boolean
  usbStatus: string
  usbError: string
  adbWindowsOpen: boolean
  switchingTransport: boolean
  adbAllowed: boolean
}>()
const emit = defineEmits<{
  refresh: []
  select: [serial: string]
  webusb: []
  transport: [value: 'adb' | 'webusb']
  cancelUsb: []
  disconnectUsb: []
}>()
const webUsbAvailable = WebUsbConnection.available()
const mode = ref(!props.adbAllowed || props.transport === 'webusb' ? 'webusb' : 'usb'),
  host = ref(''),
  pairPort = ref(''),
  connectPort = ref(''),
  code = ref(''),
  busy = ref(''),
  adbError = ref(''),
  wirelessError = ref('')
watch([() => props.transport, () => props.adbAllowed], ([value, adbAllowed]) => {
  if (!adbAllowed) {
    mode.value = 'webusb'
    return
  }
  if (value === 'webusb') mode.value = 'webusb'
  else if (mode.value === 'webusb') mode.value = 'usb'
})
watch(mode, (value, previous) => {
  if (!value) {
    mode.value = previous
    return
  }
  emit('transport', value === 'webusb' ? 'webusb' : 'adb')
})
async function releaseAdb() {
  busy.value = 'release'
  adbError.value = ''
  try {
    await api.releaseAdb()
    toast.success('已释放系统 ADB，请点击选择 USB 设备')
  } catch (cause) {
    adbError.value = `无法释放：${errorText(cause)}。可在电脑终端运行 adb kill-server。`
  } finally {
    busy.value = ''
  }
}
const validPort = (value: string) =>
  /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535
function chooseDevice(serial: string) {
  emit('select', serial)
  open.value = false
}
async function wireless(pair: boolean) {
  wirelessError.value = ''
  if (
    !host.value.trim() ||
    !validPort(pair ? pairPort.value : connectPort.value) ||
    (pair && !/^\d{6}$/.test(code.value))
  ) {
    wirelessError.value = '请填写手机 IP、有效端口，以及配对所需的六位配对码。'
    return
  }
  busy.value = pair ? 'pair' : 'connect'
  try {
    if (pair) {
      await api.pair(host.value.trim(), Number(pairPort.value), code.value)
      code.value = ''
      toast.success('配对成功，请填写连接端口')
    } else {
      const result = await api.connect(host.value.trim(), Number(connectPort.value))
      emit('select', result.serial)
      open.value = false
      toast.success('设备已连接')
    }
  } catch (e) {
    wirelessError.value = errorText(e)
  } finally {
    busy.value = ''
  }
}
</script>
<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>你的手机</DialogTitle>
      </DialogHeader>
      <ToggleGroup
        v-model="mode"
        type="single"
        variant="outline"
        class="justify-start"
        aria-label="连接方式"
        :disabled="switchingTransport || !!busy"
      >
        <ToggleGroupItem v-if="adbAllowed" value="usb">
          <Usb />
          USB / 已连接
        </ToggleGroupItem>
        <ToggleGroupItem v-if="adbAllowed" value="wireless">
          <Wifi />
          无线连接
        </ToggleGroupItem>
        <ToggleGroupItem value="webusb">
          <Usb />
          WebUSB 直连
        </ToggleGroupItem>
      </ToggleGroup>
      <template v-if="mode === 'webusb'">
        <p v-if="!webUsbAvailable" role="alert" class="text-sm text-destructive">
          WebUSB 需要 HTTPS 或 localhost，以及支持 WebUSB 的 Chrome / Edge。当前浏览器环境不可用。
        </p>
        <p v-if="adbWindowsOpen" role="status" class="text-sm text-muted-foreground">
          请先关闭系统 ADB 投屏窗口，再连接 WebUSB。
        </p>
        <p v-if="usbConnected" role="status">已通过 WebUSB 连接手机</p>
        <p v-if="switchingTransport" role="status">正在释放 USB 连接…</p>
        <p v-if="usbBusy" role="status">{{ usbStatus }}</p>
        <p v-if="usbError" role="alert" class="text-sm text-destructive">
          {{ usbError }}
        </p>
        <Button v-if="usbConnected" variant="outline" @click="emit('disconnectUsb')">
          断开 WebUSB
        </Button>
        <Button v-else-if="usbBusy" variant="outline" @click="emit('cancelUsb')">取消连接</Button>
        <Button
          v-else
          :disabled="!webUsbAvailable || adbWindowsOpen || !!busy || switchingTransport"
          @click="emit('webusb')"
        >
          <Usb data-icon="inline-start" />
          选择 USB 设备
        </Button>
      </template>
      <template v-else-if="mode !== 'wireless'">
        <div class="device-list">
          <div v-for="d in devices" :key="d.serial" class="device-row">
            <Smartphone class="size-6 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <strong>{{ d.model?.replaceAll('_', ' ') || 'Android' }}</strong>
              <p class="truncate text-xs text-muted-foreground">
                {{ d.serial }} ·
                {{
                  d.state === 'device'
                    ? '已连接'
                    : d.state === 'unauthorized'
                      ? '请在手机上允许调试'
                      : '离线'
                }}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              :disabled="d.state !== 'device' || switchingTransport"
              @click="chooseDevice(d.serial)"
            >
              <Check v-if="serial === d.serial" data-icon="inline-start" />
              {{ serial === d.serial ? '当前设备' : '使用' }}
            </Button>
          </div>
          <p v-if="!devices.length" class="py-8 text-center text-sm text-muted-foreground">
            {{ loading ? '正在寻找设备…' : '未发现设备' }}
          </p>
        </div>
        <Button
          variant="outline"
          :disabled="loading || switchingTransport"
          @click="emit('refresh')"
        >
          <RefreshCw :class="{ 'animate-spin': loading }" data-icon="inline-start" />
          重新扫描
        </Button>
        <p v-if="adbError" role="alert" class="text-sm text-destructive">{{ adbError }}</p>
        <Button
          variant="outline"
          :disabled="adbWindowsOpen || !!busy || loading || switchingTransport"
          @click="releaseAdb"
        >
          <LoaderCircle v-if="busy === 'release'" data-icon="inline-start" class="animate-spin" />
          释放系统 ADB
        </Button>
      </template>
      <form v-else class="flex flex-col gap-5" @submit.prevent="wireless(false)">
        <FieldGroup>
          <Field :data-invalid="!!wirelessError">
            <FieldLabel for="wireless-host">手机 IP 地址</FieldLabel>
            <Input
              id="wireless-host"
              v-model="host"
              placeholder="192.168.1.23"
              :aria-invalid="!!wirelessError"
            />
          </Field>
          <FieldGroup class="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel for="pair-port">配对端口</FieldLabel>
              <Input id="pair-port" v-model="pairPort" inputmode="numeric" placeholder="37001" />
            </Field>
            <Field>
              <FieldLabel for="pair-code">六位配对码</FieldLabel>
              <Input
                id="pair-code"
                v-model="code"
                maxlength="6"
                inputmode="numeric"
                placeholder="123456"
                autocomplete="off"
              />
            </Field>
          </FieldGroup>
          <Button
            type="button"
            variant="outline"
            :disabled="!!busy || switchingTransport"
            @click="wireless(true)"
          >
            <LoaderCircle v-if="busy === 'pair'" class="animate-spin" />
            配对设备
          </Button>
          <Field>
            <FieldLabel for="connect-port">连接端口</FieldLabel>
            <Input
              id="connect-port"
              v-model="connectPort"
              inputmode="numeric"
              placeholder="39521"
            />
          </Field>
        </FieldGroup>
        <p v-if="wirelessError" role="alert" class="text-sm text-destructive">
          {{ wirelessError }}
        </p>
        <Button type="submit" :disabled="!!busy || switchingTransport">
          <LoaderCircle v-if="busy === 'connect'" class="animate-spin" />
          连接手机
        </Button>
      </form>
    </DialogContent>
  </Dialog>
</template>
