<script setup lang="ts">
import { computed } from 'vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useAudioForwarding } from '@/composables/useAudioForwarding'
import { useScreenOff } from '@/composables/useScreenOff'
import { useWindowControls } from '@/composables/useWindowControls'
import { useTheme } from '@/composables/useTheme'
import ADBSettings from '@/components/ADBSettings.vue'
import { isDesktop } from '@/services/desktop'
const open = defineModel<boolean>('open', { required: true })
const { audioForwarding } = useAudioForwarding()
const { screenOff } = useScreenOff()
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
    <DialogContent class="gap-5 p-4 sm:max-w-md sm:p-6">
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
