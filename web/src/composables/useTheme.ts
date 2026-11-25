import { ref, watch } from 'vue'

export type Theme = 'dark' | 'light'

const KEY = 'mugi.theme'

function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

const theme = ref<Theme>(readTheme())

function applyTheme(value: Theme) {
  const root = document.documentElement
  root.classList.toggle('dark', value === 'dark')
  root.classList.toggle('light', value === 'light')
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', value === 'light' ? '#e9f0fa' : '#202022')
}

applyTheme(theme.value)
watch(theme, (value) => {
  applyTheme(value)
  try {
    localStorage.setItem(KEY, value)
  } catch {
    /* The theme still applies when storage is unavailable. */
  }
})

export function useTheme() {
  return { theme }
}
