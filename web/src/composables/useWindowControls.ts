import { ref, watch } from 'vue'

export type WindowControlStyle = 'windows' | 'mac'

const KEY = 'mugi.window-controls'

function read(): WindowControlStyle {
  try {
    return localStorage.getItem(KEY) === 'mac' ? 'mac' : 'windows'
  } catch {
    return 'windows'
  }
}

const windowControlStyle = ref<WindowControlStyle>(read())
watch(windowControlStyle, (value) => {
  try {
    localStorage.setItem(KEY, value)
  } catch {
    /* optional preference */
  }
})

export function useWindowControls() {
  return { windowControlStyle }
}
