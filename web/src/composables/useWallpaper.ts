import { computed, onBeforeUnmount, ref, watch } from 'vue'
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
  const wallpaperUrl = ref('')
  const loading = ref(true)
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
    loading.value = true
    try {
      const image = await readWallpaper()
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
  onBeforeUnmount(() => useObjectUrl(null))

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
