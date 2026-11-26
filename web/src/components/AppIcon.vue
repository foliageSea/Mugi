<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{ iconUrl?: string }>()
const failedUrl = ref<string>()
const loadedUrl = ref<string>()
const hasImage = computed(
  () => !!props.iconUrl && loadedUrl.value === props.iconUrl && failedUrl.value !== props.iconUrl,
)
function imageSource(event: Event) {
  return (event.currentTarget as HTMLImageElement).getAttribute('src') || undefined
}
</script>
<template>
  <span class="app-art" aria-hidden="true">
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
    <span v-if="!hasImage" class="generic-art">
      <svg class="android-app-placeholder" viewBox="0 0 24 24" fill="currentColor">
        <path d="M2 18a10 10 0 0 1 20 0Z" />
        <path
          d="m6.8 9.6-2-3.4m12.4 3.4 2-3.4"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
        <circle cx="7.8" cy="14.2" r="1" fill="var(--app-icon-background)" />
        <circle cx="16.2" cy="14.2" r="1" fill="var(--app-icon-background)" />
      </svg>
    </span>
  </span>
</template>
