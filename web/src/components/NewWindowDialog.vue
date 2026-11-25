<script setup lang="ts">
import { ref, watch } from 'vue'
import { RectangleHorizontal, Smartphone, Square } from '@lucide/vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useAudioForwarding } from '@/composables/useAudioForwarding'
import type { AndroidApp, SessionOptions, WindowShape } from '@/types'
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ apps: AndroidApp[] }>()
const emit = defineEmits<{ create: [opts: SessionOptions, app?: AndroidApp] }>()
const { audioForwarding } = useAudioForwarding()
const app = ref(''),
  shape = ref<WindowShape>('portrait'),
  audio = ref(audioForwarding.value),
  decorations = ref(false)
watch(open, (isOpen) => {
  if (isOpen) audio.value = audioForwarding.value
})
function submit() {
  const size =
    shape.value === 'landscape'
      ? { width: 1600, height: 900, dpi: 240 }
      : shape.value === 'wide'
        ? { width: 1800, height: 1200, dpi: 240 }
        : { width: 900, height: 1600, dpi: 280 }
  emit(
    'create',
    {
      mode: 'display',
      ...size,
      startApp: app.value,
      audio: audio.value,
      decorations: decorations.value,
    },
    props.apps.find((a) => a.package === app.value),
  )
}
</script>
<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>新建窗口</DialogTitle>
        <DialogDescription>为应用创建独立屏幕，自由安排你的工作区。</DialogDescription>
      </DialogHeader>
      <form class="flex flex-col gap-6" @submit.prevent="submit">
        <FieldGroup>
          <Field>
            <FieldLabel for="window-app">启动应用</FieldLabel>
            <Select v-model="app">
              <SelectTrigger id="window-app" class="w-full" aria-label="启动应用">
                <SelectValue placeholder="不指定应用" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem v-for="a in apps" :key="a.package" :value="a.package">
                    {{ a.name }}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>窗口形态</FieldLabel>
            <ToggleGroup
              v-model="shape"
              type="single"
              variant="outline"
              class="justify-start"
              aria-label="窗口形态"
            >
              <ToggleGroupItem value="portrait">
                <Smartphone />
                竖屏
              </ToggleGroupItem>
              <ToggleGroupItem value="landscape">
                <RectangleHorizontal />
                横屏
              </ToggleGroupItem>
              <ToggleGroupItem value="wide">
                <Square />
                宽屏
              </ToggleGroupItem>
            </ToggleGroup>
            <FieldDescription>拖动窗口右下角可等比缩放，不改变应用布局。</FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <Switch id="window-audio" v-model="audio" />
            <FieldLabel for="window-audio">转发设备音频</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Switch id="window-decorations" v-model="decorations" />
            <FieldLabel for="window-decorations">显示 Android 系统装饰</FieldLabel>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" @click="open = false">取消</Button>
          <Button type="submit">创建窗口</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
