<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { openTerminal, type TerminalConnection } from '@/services/terminal'
import { errorText } from '@/services/api'
import { abortable } from '@/services/webusb-helpers'
import { useTheme } from '@/composables/useTheme'

const props = defineProps<{ serial: string }>()
const container = ref<HTMLElement>()
const status = ref('正在连接 Android Shell…')
const connected = ref(false)
const busy = ref(false)
let terminal: Terminal | undefined
let connection: TerminalConnection | undefined
let controller: AbortController | undefined
let observer: ResizeObserver | undefined
let fit: FitAddon | undefined
let inputQueue = Promise.resolve()
let pendingBytes = 0

function stop() {
  controller?.abort()
  connection?.close()
  connection = undefined
  connected.value = false
}
async function start() {
  stop()
  const current = new AbortController()
  controller = current
  busy.value = true
  status.value = '正在连接 Android Shell…'
  terminal?.reset()
  fit?.fit()
  let exited = false
  try {
    const result = await openTerminal(
      props.serial,
      terminal!.rows,
      terminal!.cols,
      current.signal,
      (data) =>
        abortable(new Promise<void>((resolve) => terminal?.write(data, resolve)), current.signal),
      (message) => {
        exited = true
        connected.value = false
        status.value = message
      },
    )
    if (current.signal.aborted) {
      result.close()
      return
    }
    connection = result
    if (!exited) {
      connected.value = true
      status.value = '已连接 · Android Shell'
      terminal?.focus()
    }
  } catch (error) {
    if (!current.signal.aborted) status.value = errorText(error)
  } finally {
    if (controller === current) busy.value = false
  }
}

const { theme } = useTheme()
function terminalTheme() {
  const style = getComputedStyle(container.value!)
  return { background: style.backgroundColor, foreground: style.color, cursor: style.color }
}
watch(
  theme,
  () => {
    if (terminal && container.value) terminal.options.theme = terminalTheme()
  },
  { flush: 'post' },
)

onMounted(() => {
  terminal = new Terminal({
    cursorBlink: true,
    fontFamily:
      '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace',
    fontSize: 13,
    scrollback: 3000,
    theme: terminalTheme(),
  })
  fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(container.value!)
  fit.fit()
  terminal.onData((data) => {
    const target = connection
    if (!target || !connected.value) return
    if (pendingBytes + data.length > 1024 * 1024) {
      status.value = '输入过快，请稍后重试'
      return
    }
    pendingBytes += data.length
    inputQueue = inputQueue
      .then(async () => {
        if (connection !== target) return
        // Bound WebSocket frames while preserving surrogate pairs in pasted text.
        for (let offset = 0; offset < data.length;) {
          let end = Math.min(offset + 8192, data.length)
          if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--
          await target.write(data.slice(offset, end))
          offset = end
        }
      })
      .catch((error) => {
        if (connection === target) {
          status.value = errorText(error)
          stop()
        }
      })
      .finally(() => {
        pendingBytes -= data.length
      })
  })
  terminal.onResize(({ rows, cols }) => {
    void connection?.resize(rows, cols).catch((error) => {
      status.value = errorText(error)
    })
  })
  observer = new ResizeObserver(() => {
    if (container.value?.clientWidth) fit?.fit()
  })
  observer.observe(container.value!)
  void start()
})
onBeforeUnmount(() => {
  stop()
  observer?.disconnect()
  terminal?.dispose()
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div ref="container" class="android-terminal" aria-label="Android 交互式终端" />
  </div>
</template>
