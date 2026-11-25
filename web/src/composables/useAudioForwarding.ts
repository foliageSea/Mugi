import { ref, watch } from 'vue'

const KEY = 'mugi.audio-forwarding'

function read() {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

const audioForwarding = ref(read())
watch(audioForwarding, (value) => {
  try {
    localStorage.setItem(KEY, value ? '1' : '0')
  } catch {
    /* optional preference */
  }
})

export function useAudioForwarding() {
  return { audioForwarding }
}
