<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useAudioForwarding } from '@/composables/useAudioForwarding'
import { castPresets, useCastSettings } from '@/composables/useCastSettings'
import { useScreenOff } from '@/composables/useScreenOff'
import { useWindowControls } from '@/composables/useWindowControls'
import { useTheme } from '@/composables/useTheme'
import ADBSettings from '@/components/ADBSettings.vue'
import { isDesktop } from '@/services/desktop'
const open = defineModel<boolean>('open', { required: true })
const { audioForwarding } = useAudioForwarding()
const { screenOff } = useScreenOff()
const { castSettings, resetCastSettings } = useCastSettings()
const castFields = [
  { key: 'maxSize', label: '镜像最大长边', unit: 'px', fallback: '自动' },
  { key: 'maxFps', label: '最高帧率', unit: 'fps', fallback: '不限' },
  { key: 'bitRateMbps', label: '视频码率', unit: 'Mbps', fallback: '' },
] as const
const { windowControlStyle } = useWindowControls()
const { theme } = useTheme()
const lightMode = computed({
  get: () => theme.value === 'light',
  set: (enabled) => {
    theme.value = enabled ? 'light' : 'dark'
  },
})
</script>
<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto p-4 sm:max-w-md sm:p-6">
      <DialogHeader class="pr-7 text-left">
        <DialogTitle>设置</DialogTitle>
      </DialogHeader>

      <div class="grid min-w-0 gap-3">
        <div role="group" aria-label="外观" class="settings-group">
          <div class="settings-row">
            <FieldLabel for="settings-light-mode">亮色模式</FieldLabel>
            <Switch id="settings-light-mode" v-model="lightMode" />
          </div>
          <div class="settings-row">
            <span id="settings-window-style" class="text-sm leading-snug font-medium">
              窗口按钮样式
            </span>
            <ToggleGroup
              v-model="windowControlStyle"
              type="single"
              variant="outline"
              size="sm"
              class="shrink-0"
              aria-labelledby="settings-window-style"
            >
              <ToggleGroupItem value="windows" class="px-2 sm:px-3">Windows</ToggleGroupItem>
              <ToggleGroupItem value="mac" class="px-2 sm:px-3">Mac</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        <div role="group" aria-label="设备偏好" class="settings-group">
          <div class="settings-row">
            <FieldLabel for="settings-audio-forwarding">默认转发设备音频</FieldLabel>
            <Switch id="settings-audio-forwarding" v-model="audioForwarding" />
          </div>
          <div class="settings-row">
            <FieldLabel for="settings-screen-off">自动息屏</FieldLabel>
            <Switch id="settings-screen-off" v-model="screenOff" />
          </div>
        </div>

        <section class="settings-group" aria-labelledby="settings-cast-title">
          <div class="settings-row">
            <div class="grid gap-0.5">
              <h2 id="settings-cast-title" class="text-sm font-medium">投屏参数</h2>
              <p class="text-muted-foreground text-xs">仅对新建投屏生效</p>
            </div>
            <Button type="button" variant="ghost" size="sm" @click="resetCastSettings">
              恢复默认
            </Button>
          </div>
          <div v-for="field in castFields" :key="field.key" class="settings-row">
            <FieldLabel :for="`settings-cast-${field.key}`">{{ field.label }}</FieldLabel>
            <Select v-model="castSettings[field.key]">
              <SelectTrigger :id="`settings-cast-${field.key}`" size="sm" class="w-28 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem v-for="value in castPresets[field.key]" :key="value" :value="value">
                  {{ value ? `${value} ${field.unit}` : field.fallback }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </section>

        <div v-if="isDesktop && open" class="settings-group p-3 sm:p-4">
          <ADBSettings />
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
@reference "../style.css";

.settings-group {
  @apply min-w-0 divide-y divide-border rounded-lg border border-border bg-muted/20;
}

.settings-row {
  @apply flex min-h-12 min-w-0 items-center justify-between gap-2 px-3 py-2 sm:px-4;
}
</style>
