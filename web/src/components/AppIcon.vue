<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Camera,
  Settings,
  Globe,
  Folder,
  Calculator,
  Play,
  Mail,
  Music,
  AppWindow,
} from '@lucide/vue'
const props = defineProps<{ name: string; package?: string; iconUrl?: string }>()
const failedUrl = ref<string>()
const loadedUrl = ref<string>()
const hasImage = computed(
  () => !!props.iconUrl && loadedUrl.value === props.iconUrl && failedUrl.value !== props.iconUrl,
)
function imageSource(event: Event) {
  return (event.currentTarget as HTMLImageElement).getAttribute('src') || undefined
}
const kind = computed(() => {
  const text = `${props.name} ${props.package}`.toLowerCase()
  if (/相册|照片|图库|gallery|photos/.test(text)) return 'photos'
  if (/信息|短信|messages|mms/.test(text)) return 'messages'
  if (/地图|maps|map|autonavi/.test(text)) return 'maps'
  return 'generic'
})
const icon = computed(() => {
  const text = `${props.name} ${props.package}`.toLowerCase()
  if (/设置|settings/.test(text)) return Settings
  if (/相机|camera/.test(text)) return Camera
  if (/浏览器|chrome|firefox|browser/.test(text)) return Globe
  if (/文件|file|云盘|网盘/.test(text)) return Folder
  if (/计算|calculator/.test(text)) return Calculator
  if (/音乐|music/.test(text)) return Music
  if (/邮件|mail/.test(text)) return Mail
  if (/视频|video|youtube/.test(text)) return Play
  return AppWindow
})
const tone = computed(
  () => [...(props.package || props.name)].reduce((n, c) => n + c.charCodeAt(0), 0) % 6,
)
</script>
<template>
  <span class="app-art" :data-tone="tone" aria-hidden="true">
    <img
      v-if="iconUrl && failedUrl !== iconUrl"
      :key="iconUrl"
      :src="iconUrl"
      class="android-app-icon"
      :class="{ 'is-loaded': hasImage }"
      alt=""
      loading="lazy"
      decoding="async"
      @load="loadedUrl = imageSource($event)"
      @error="failedUrl = imageSource($event)"
    />
    <svg v-if="!hasImage && kind === 'photos'" viewBox="0 0 48 48" fill="none">
      <rect
        x="5"
        y="4"
        width="37"
        height="39"
        rx="11"
        fill="#c7d89c"
        stroke="#50545b"
        stroke-width="2.5"
      />
      <circle cx="32" cy="14" r="5" fill="#c885ae" stroke="#50545b" stroke-width="2" />
      <path
        d="M7 34 18 21l8 9 6-5 9 10v1c0 4-5 6-9 6H16c-5 0-8-3-9-8Z"
        fill="#8dc1d1"
        stroke="#50545b"
        stroke-width="2.5"
        stroke-linejoin="round"
      />
    </svg>
    <svg v-else-if="!hasImage && kind === 'messages'" viewBox="0 0 48 48" fill="none">
      <path
        d="M7 6h34v28H24l-11 8v-8H7z"
        fill="#83c4c6"
        stroke="#50545b"
        stroke-width="2.5"
        stroke-linejoin="round"
      />
      <circle cx="16" cy="17" r="4.5" fill="#d194b6" stroke="#50545b" stroke-width="2" />
      <path
        d="M26 14h9m-9 6h7M13 27h22"
        stroke="#50545b"
        stroke-width="2.5"
        stroke-linecap="round"
      />
    </svg>
    <svg v-else-if="!hasImage && kind === 'maps'" viewBox="0 0 48 48" fill="none">
      <path
        d="m5 10 12-6 14 6 12-6v34l-12 6-14-6-12 6z"
        fill="#c9d595"
        stroke="#50545b"
        stroke-width="2.5"
        stroke-linejoin="round"
      />
      <path d="M17 4v34m14-28v34M5 28l12-6 14 7 12-7" stroke="#50545b" stroke-width="2.5" />
      <path
        d="M28 13c0-8 14-8 14 0 0 5-7 12-7 12s-7-7-7-12Z"
        fill="#ca8cab"
        stroke="#50545b"
        stroke-width="2"
      />
      <circle cx="35" cy="12" r="2.5" fill="#efdbaf" />
    </svg>
    <span v-else-if="!hasImage" class="generic-art"><component :is="icon" /></span>
  </span>
</template>
