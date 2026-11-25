import {
  computed,
  inject,
  nextTick,
  provide,
  readonly,
  ref,
  shallowRef,
  type InjectionKey,
} from 'vue'

interface WindowRegistration {
  focus: () => void
  activeLayer: number
}

const windowManagerKey: InjectionKey<ReturnType<typeof createWindowManager>> =
  Symbol('window-manager')

function createWindowManager(focusDock: (id: string) => void) {
  const entries = shallowRef(new Map<string, WindowRegistration>())
  const activeId = ref('')
  const minimized = ref<string[]>([])
  const windowIds = computed(() => [...entries.value.keys()])
  const visibleIds = computed(() => windowIds.value.filter((id) => !minimized.value.includes(id)))
  let recent: string[] = []

  function activate(id: string) {
    if (!entries.value.has(id)) return
    minimized.value = minimized.value.filter((item) => item !== id)
    activeId.value = id
    recent = [...recent.filter((item) => item !== id), id]
  }

  function focusWindow(id: string) {
    activate(id)
    void nextTick(() => {
      if (activeId.value === id && !minimized.value.includes(id)) entries.value.get(id)?.focus()
    })
  }

  function activateLast() {
    const id = recent.filter((item) => visibleIds.value.includes(item)).at(-1) || ''
    activeId.value = id
    if (id) focusWindow(id)
  }

  function register(id: string, entry: WindowRegistration) {
    entries.value = new Map(entries.value).set(id, entry)
    focusWindow(id)
    return () => {
      // A late unmount must not remove a replacement registered under the same ID.
      if (entries.value.get(id) !== entry) return
      const next = new Map(entries.value)
      next.delete(id)
      entries.value = next
      minimized.value = minimized.value.filter((item) => item !== id)
      recent = recent.filter((item) => item !== id)
      if (activeId.value === id) activateLast()
    }
  }

  function minimizeWindow(id: string) {
    if (!entries.value.has(id) || minimized.value.includes(id)) return
    minimized.value = [...minimized.value, id]
    if (activeId.value === id) activateLast()
    void nextTick(() => focusDock(id))
  }

  function toggleDesktop() {
    if (visibleIds.value.length) {
      minimized.value = [...windowIds.value]
      activeId.value = ''
    } else {
      minimized.value = []
      activateLast()
    }
  }

  function zIndex(id: string) {
    return activeId.value === id ? (entries.value.get(id)?.activeLayer ?? 1) : 1
  }

  return {
    activeId: readonly(activeId),
    minimized: readonly(minimized),
    windowIds,
    visibleIds,
    register,
    activate,
    focusWindow,
    minimizeWindow,
    toggleDesktop,
    zIndex,
  }
}

export function provideWindowManager(focusDock: (id: string) => void) {
  const manager = createWindowManager(focusDock)
  provide(windowManagerKey, manager)
  return manager
}

export function useWindowManager() {
  const manager = inject(windowManagerKey)
  if (!manager) throw new Error('WindowFrame requires a provided window manager')
  return manager
}
