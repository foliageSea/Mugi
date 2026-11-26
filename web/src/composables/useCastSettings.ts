import { ref, watch } from 'vue'

const KEY = 'mugi.cast-settings'
export const castPresets = {
  maxSize: [0, 720, 1080, 1440, 2160],
  maxFps: [0, 30, 60, 90, 120],
  bitRateMbps: [2, 4, 8, 12, 16, 24],
}

const defaults = { maxSize: 0, maxFps: 0, bitRateMbps: 8 }

function read() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    const result = { ...defaults }
    for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
      if (castPresets[key].includes(saved?.[key])) result[key] = saved[key]
    }
    return result
  } catch {
    return { ...defaults }
  }
}

const castSettings = ref(read())
watch(
  castSettings,
  (value) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(value))
    } catch {
      /* optional preference */
    }
  },
  { deep: true },
)

export function useCastSettings() {
  return {
    castSettings,
    resetCastSettings: () => {
      castSettings.value = { ...defaults }
    },
  }
}
