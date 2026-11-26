<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Search, RefreshCw, Monitor, FolderOpen, ArrowRight } from '@lucide/vue'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'
import AppIcon from './AppIcon.vue'
import type { AndroidApp } from '@/types'
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{
  apps: AndroidApp[]
  loading: boolean
  error: string
  connected: boolean
  starting: boolean
  canFiles: boolean
}>()
const emit = defineEmits<{
  launch: [app: AndroidApp]
  mirror: []
  refresh: []
  connect: []
  files: []
}>()
const query = ref('')
const filtered = computed(() =>
  props.apps.filter((app) =>
    `${app.name} ${app.package}`.toLowerCase().includes(query.value.trim().toLowerCase()),
  ),
)
watch(open, (value) => {
  if (!value) query.value = ''
})
function keyboard(event: KeyboardEvent) {
  const container = event.currentTarget as HTMLElement
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.launcher-item'))
  const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const columns = window.innerWidth < 540 ? 3 : 4
  const delta: Record<string, number> = {
    ArrowRight: 1,
    ArrowLeft: -1,
    ArrowDown: columns,
    ArrowUp: -columns,
  }
  if (i < 0 || delta[event.key] === undefined) return
  event.preventDefault()
  buttons[Math.max(0, Math.min(buttons.length - 1, i + delta[event.key]))]?.focus()
}
</script>
<template>
  <Dialog v-model:open="open">
    <DialogContent variant="launcher" :show-close-button="false" :show-overlay="false">
      <DialogTitle class="sr-only">应用启动器</DialogTitle>
      <DialogDescription class="sr-only">
        搜索手机应用，在独立窗口中打开。使用方向键选择应用。
      </DialogDescription>
      <div class="launcher-search">
        <Search class="size-5 shrink-0" />
        <Input
          v-model="query"
          variant="search"
          placeholder="搜索 App"
          aria-label="搜索 App"
          @keydown.enter="filtered[0] && emit('launch', filtered[0])"
          @keydown.down.prevent="
            ($event.currentTarget as HTMLElement)
              .closest('[role=dialog]')
              ?.querySelector<HTMLButtonElement>('.launcher-item')
              ?.focus()
          "
        />
        <kbd>ESC</kbd>
      </div>
      <Separator />
      <div class="launcher-label">
        <span>{{ query ? `搜索结果 · ${filtered.length}` : '所有 App' }}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          :disabled="loading || !connected"
          aria-label="刷新应用"
          @click="emit('refresh')"
        >
          <RefreshCw :class="{ 'animate-spin': loading }" />
        </Button>
      </div>
      <div v-if="loading" class="launcher-grid" aria-label="正在读取应用">
        <div v-for="i in 8" :key="i" class="launcher-placeholder">
          <Skeleton class="size-11 rounded-xl" />
          <Skeleton class="h-3 w-12" />
        </div>
      </div>
      <div v-else-if="filtered.length" class="launcher-grid" @keydown="keyboard">
        <button
          v-for="app in filtered"
          :key="app.package"
          class="launcher-item"
          :disabled="starting"
          :title="app.package"
          :aria-label="`打开 ${app.name}`"
          @click="emit('launch', app)"
        >
          <AppIcon :icon-url="app.iconUrl" />
          <span>{{ app.name }}</span>
        </button>
      </div>
      <Empty v-else class="min-h-56">
        <EmptyHeader>
          <EmptyTitle>
            {{ !connected ? '连接你的 Android 手机' : error ? '暂时无法读取应用' : '没有找到应用' }}
          </EmptyTitle>
          <EmptyDescription>
            {{
              !connected
                ? '通过 USB 或无线调试连接后，应用会显示在这里。'
                : error || '试试其他应用名称或包名。'
            }}
          </EmptyDescription>
        </EmptyHeader>
        <Button v-if="!connected" @click="emit('connect')">
          连接设备
          <ArrowRight data-icon="inline-end" />
        </Button>
        <Button v-else-if="error" variant="outline" @click="emit('refresh')">重新读取</Button>
      </Empty>
      <Separator />
      <footer class="launcher-footer">
        <Button
          variant="ghost"
          size="sm"
          :disabled="starting || !connected"
          @click="emit('mirror')"
        >
          <Monitor data-icon="inline-start" />
          镜像屏幕
        </Button>
        <Button
          variant="ghost"
          size="sm"
          :disabled="!connected || !canFiles"
          @click="emit('files')"
        >
          <FolderOpen data-icon="inline-start" />
          文件管理器
        </Button>
        <span class="launcher-hint">↵ 打开应用</span>
      </footer>
    </DialogContent>
  </Dialog>
</template>
