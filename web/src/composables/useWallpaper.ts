import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { deleteWallpaper, readWallpaper, writeWallpaper } from '@/services/wallpaper'

const PREFERENCES_KEY = 'mugi.wallpaper.preferences.v1'
const DEFAULT_BRIGHTNESS = 100
const DEFAULT_CONTRAST = 100

type WallpaperPreferences = {
  brightness: number
  contrast: number
  name: string
}

function bounded(value: unknown, fallback: number) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(160, Math.max(40, Math.round(number))) : fallback
}

function storedPreferences(): WallpaperPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || '{}')
    return {
      brightness: bounded(value.brightness, DEFAULT_BRIGHTNESS),
      contrast: bounded(value.contrast, DEFAULT_CONTRAST),
      name: typeof value.name === 'string' ? value.name : '',
    }
  } catch {
    return { brightness: DEFAULT_BRIGHTNESS, contrast: DEFAULT_CONTRAST, name: '' }
  }
}

export function useWallpaper() {
  const preferences = storedPreferences()
  const brightness = ref(preferences.brightness)
  const contrast = ref(preferences.contrast)
  const wallpaperName = ref(preferences.name)
  // Vue can remount the desktop during HMR. Keep its wallpaper URL available
  // instead of showing the default while IndexedDB is read again.
  const hotData = import.meta.hot?.data as { wallpaperUrl?: Ref<string> } | undefined
  const wallpaperUrl = hotData?.wallpaperUrl ?? ref('')
  if (hotData) hotData.wallpaperUrl = wallpaperUrl
  const loading = ref(!wallpaperUrl.value)
  const hasCustomWallpaper = computed(() => !!wallpaperUrl.value)
  const wallpaperStyle = computed(() => ({
    backgroundImage: wallpaperUrl.value ? `url("${wallpaperUrl.value}")` : undefined,
    filter: `brightness(${brightness.value}%) contrast(${contrast.value}%)`,
  }))

  function remember() {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({
        brightness: brightness.value,
        contrast: contrast.value,
        name: wallpaperName.value,
      }),
    )
  }

  function useObjectUrl(blob: Blob | null) {
    if (wallpaperUrl.value) URL.revokeObjectURL(wallpaperUrl.value)
    wallpaperUrl.value = blob ? URL.createObjectURL(blob) : ''
  }

  async function load() {
    if (wallpaperUrl.value) return
    loading.value = true
    try {
      const image = await readWallpaper()
      if (wallpaperUrl.value) return
      useObjectUrl(image)
      if (!image) {
        wallpaperName.value = ''
        remember()
      }
    } finally {
      loading.value = false
    }
  }

  async function replace(file: File) {
    loading.value = true
    try {
      await writeWallpaper(file)
      useObjectUrl(file)
      wallpaperName.value = file.name
      remember()
    } finally {
      loading.value = false
    }
  }

  async function reset() {
    loading.value = true
    try {
      await deleteWallpaper()
      useObjectUrl(null)
      wallpaperName.value = ''
      brightness.value = DEFAULT_BRIGHTNESS
      contrast.value = DEFAULT_CONTRAST
      remember()
    } finally {
      loading.value = false
    }
  }

  watch([brightness, contrast], remember)
  // In dev the page owns the URL across remounts; replacement and reset still revoke it.
  if (!hotData) onBeforeUnmount(() => useObjectUrl(null))

  return {
    brightness,
    contrast,
    wallpaperName,
    wallpaperUrl,
    wallpaperStyle,
    hasCustomWallpaper,
    loading,
    load,
    replace,
    reset,
  }
}
