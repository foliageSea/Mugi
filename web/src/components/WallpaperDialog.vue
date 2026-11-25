<script setup lang="ts">
import { computed, ref } from 'vue'
import { ImagePlus, LoaderCircle, RotateCcw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Slider } from '@/components/ui/slider'

const open = defineModel<boolean>('open', { required: true })
const brightness = defineModel<number>('brightness', { required: true })
const contrast = defineModel<number>('contrast', { required: true })
const props = defineProps<{
  wallpaperUrl: string
  wallpaperName: string
  loading: boolean
}>()
const emit = defineEmits<{
  select: [file: File]
  reset: []
}>()

const picker = ref<HTMLInputElement>()
const brightnessValue = computed({
  get: () => [brightness.value],
  set: (value: number[]) => (brightness.value = value[0] ?? 100),
})
const contrastValue = computed({
  get: () => [contrast.value],
  set: (value: number[]) => (contrast.value = value[0] ?? 100),
})
const previewStyle = computed(() => ({
  backgroundImage: props.wallpaperUrl ? `url("${props.wallpaperUrl}")` : undefined,
  filter: `brightness(${brightness.value}%) contrast(${contrast.value}%)`,
}))
const adjusted = computed(() => brightness.value !== 100 || contrast.value !== 100)

function choose(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) emit('select', file)
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="wallpaper-dialog">
      <DialogHeader>
        <DialogTitle>桌面与壁纸</DialogTitle>
      </DialogHeader>

      <div class="wallpaper-preview" aria-label="壁纸预览">
        <div
          class="wallpaper-preview-image"
          :class="{ custom: wallpaperUrl }"
          :style="previewStyle"
        />
        <span>{{ wallpaperName || 'mugi 默认壁纸' }}</span>
      </div>

      <FieldGroup>
        <Field>
          <div class="wallpaper-control-label">
            <FieldLabel for="wallpaper-brightness">亮度</FieldLabel>
            <output for="wallpaper-brightness">{{ brightness }}%</output>
          </div>
          <Slider
            id="wallpaper-brightness"
            v-model="brightnessValue"
            :min="40"
            :max="160"
            :step="1"
            aria-label="壁纸亮度"
          />
        </Field>
        <Field>
          <div class="wallpaper-control-label">
            <FieldLabel for="wallpaper-contrast">对比度</FieldLabel>
            <output for="wallpaper-contrast">{{ contrast }}%</output>
          </div>
          <Slider
            id="wallpaper-contrast"
            v-model="contrastValue"
            :min="40"
            :max="160"
            :step="1"
            aria-label="壁纸对比度"
          />
        </Field>
      </FieldGroup>

      <input
        ref="picker"
        type="file"
        accept="image/*"
        class="sr-only"
        aria-label="选择壁纸图片"
        @change="choose"
      />
      <DialogFooter class="wallpaper-actions">
        <Button
          variant="ghost"
          :disabled="loading || (!wallpaperUrl && !adjusted)"
          @click="emit('reset')"
        >
          <LoaderCircle v-if="loading" data-icon="inline-start" class="animate-spin" />
          <RotateCcw v-else data-icon="inline-start" />
          恢复默认
        </Button>
        <Button variant="outline" :disabled="loading" @click="picker?.click()">
          <ImagePlus data-icon="inline-start" />
          选择图片
        </Button>
        <Button @click="open = false">完成</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
