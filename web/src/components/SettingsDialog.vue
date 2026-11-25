<script setup lang="ts">
import { computed } from 'vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldContent, FieldGroup, FieldLabel } from '@/components/ui/field'
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
    <DialogContent>
      <DialogHeader>
        <DialogTitle>设置</DialogTitle>
      </DialogHeader>
      <FieldGroup>
        <ADBSettings v-if="isDesktop && open" />
        <Field orientation="horizontal">
          <Switch id="settings-light-mode" v-model="lightMode" />
          <FieldContent>
            <FieldLabel for="settings-light-mode">亮色模式</FieldLabel>
          </FieldContent>
        </Field>
        <Field>
          <FieldLabel>窗口按钮样式</FieldLabel>
          <ToggleGroup
            v-model="windowControlStyle"
            type="single"
            variant="outline"
            class="justify-start"
            aria-label="窗口按钮样式"
          >
            <ToggleGroupItem value="windows">Windows</ToggleGroupItem>
            <ToggleGroupItem value="mac">Mac</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field orientation="horizontal">
          <Switch id="settings-audio-forwarding" v-model="audioForwarding" />
          <FieldContent>
            <FieldLabel for="settings-audio-forwarding">默认转发设备音频</FieldLabel>
          </FieldContent>
        </Field>
        <Field orientation="horizontal">
          <Switch id="settings-screen-off" v-model="screenOff" />
          <FieldContent>
            <FieldLabel for="settings-screen-off">自动息屏</FieldLabel>
          </FieldContent>
        </Field>
      </FieldGroup>
    </DialogContent>
  </Dialog>
</template>
