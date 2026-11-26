import { ref, watch } from 'vue'

export type DockPosition = 'left' | 'bottom' | 'right'

const KEY = 'mugi.dock-position'

function read(): DockPosition {
  try {
    const value = localStorage.getItem(KEY)
    if (value === 'bottom' || value === 'right') return value
  } catch {
    /* optional preference */
  }
  return 'left'
}

const dockPosition = ref<DockPosition>(read())
watch(dockPosition, (value) => {
  try {
    localStorage.setItem(KEY, value)
  } catch {
    /* optional preference */
  }
})

export function useDockPosition() {
  return { dockPosition }
}
