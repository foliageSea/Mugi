import { ref, watch } from 'vue'

const KEY = 'mugi.screen-off'

function read() {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

// Global casting preference: turn the phone screen off once a mirror or app
// window starts streaming. Defaults to on and applies to newly connected
// windows; toggling it does not change sessions that are already running.
const screenOff = ref(read())
watch(screenOff, (value) => {
  try {
    localStorage.setItem(KEY, value ? '1' : '0')
  } catch {
    /* optional preference */
  }
})

export function useScreenOff() {
  return { screenOff }
}
