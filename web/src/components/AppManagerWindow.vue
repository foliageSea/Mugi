<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RefreshCw, Download } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { api, errorText } from '@/services/api'
import { requireWebUsbConnection } from '@/services/webusb'
import {
  operate,
  parsePackages,
  parsePackageInfo,
  parseAPKPaths,
  exportAPK,
  downloadBlob,
  type ManagedApp,
  type Operation,
} from '@/services/workbench'
import type { AndroidApp } from '@/types'
import AppIcon from './AppIcon.vue'
import WindowFrame from './WindowFrame.vue'
import ConfirmOperation from './ConfirmOperation.vue'

const props = defineProps<{ serial: string; deviceName: string; apps: AndroidApp[] }>()
const emit = defineEmits<{ close: []; changed: []; install: [] }>()
const packages = ref<ManagedApp[]>([]),
  selected = ref(''),
  query = ref(''),
  filter = ref('all')
const loading = ref(false),
  detailLoading = ref(false),
  busy = ref(''),
  error = ref(''),
  raw = ref(''),
  paths = ref<string[]>([])
const controller = new AbortController()
let detailRequest: AbortController | undefined
const confirmOpen = ref(false),
  pending = ref<{ operation: Operation; pkg: string; title: string; description: string }>()
const fallbackApps = ref<AndroidApp[]>([])
const apps = computed(() => {
  const metadata = new Map(
    (props.apps.length ? props.apps : fallbackApps.value).map((app) => [app.package, app]),
  )
  return packages.value
    .map((app) => ({
      ...app,
      name: metadata.get(app.package)?.name || app.package,
      iconUrl: metadata.get(app.package)?.iconUrl,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans'))
})
const current = computed(() => apps.value.find((a) => a.package === selected.value))
const visible = computed(() =>
  apps.value.filter(
    (a) =>
      (filter.value === 'all' ||
        (filter.value === 'system'
          ? a.system
          : filter.value === 'disabled'
            ? a.disabled
            : !a.system)) &&
      `${a.name} ${a.package}`.toLowerCase().includes(query.value.toLowerCase()),
  ),
)
const details = computed(() => parsePackageInfo(raw.value))
async function refresh() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const all = parsePackages(await operate(props.serial, 'packages', '', controller.signal))
    if (controller.signal.aborted) return
    packages.value = all
    if (!all.some((a) => a.package === selected.value)) selected.value = ''
  } catch (cause) {
    if (!controller.signal.aborted) error.value = errorText(cause)
  } finally {
    loading.value = false
  }
}
watch(selected, async (pkg) => {
  detailRequest?.abort()
  raw.value = ''
  paths.value = []
  detailLoading.value = false
  if (!pkg) return
  const task = new AbortController()
  detailRequest = task
  detailLoading.value = true
  error.value = ''
  try {
    const [info, apkPaths] = await Promise.all([
      operate(props.serial, 'package-info', pkg, task.signal),
      operate(props.serial, 'package-paths', pkg, task.signal),
    ])
    if (task.signal.aborted) return
    raw.value = info
    paths.value = parseAPKPaths(apkPaths)
  } catch (cause) {
    if (!task.signal.aborted) error.value = errorText(cause)
  } finally {
    if (detailRequest === task) detailLoading.value = false
  }
})
async function run(operation: Operation, pkg = selected.value) {
  if (!pkg || busy.value) return
  busy.value = '正在执行'
  error.value = ''
  try {
    await operate(props.serial, operation, pkg, controller.signal)
    if (controller.signal.aborted) return
    toast.success('应用操作已完成')
    if (['app-uninstall', 'app-disable', 'app-enable', 'app-clear'].includes(operation)) {
      emit('changed')
      await refresh()
    }
  } catch (cause) {
    if (!controller.signal.aborted) error.value = errorText(cause)
  } finally {
    busy.value = ''
  }
}
function confirm(operation: Operation, title: string, description: string) {
  if (!current.value) return
  pending.value = {
    operation,
    pkg: selected.value,
    title,
    description: `${current.value.name}（${selected.value}）：${description}`,
  }
  confirmOpen.value = true
}
async function exportFile(index: number) {
  const pkg = selected.value,
    name = paths.value[index]?.split('/').at(-1) || `${index}.apk`
  busy.value = '正在导出 APK'
  error.value = ''
  try {
    const blob = await exportAPK(props.serial, pkg, index, controller.signal)
    if (!controller.signal.aborted) downloadBlob(blob, `${pkg}-${name}`)
  } catch (cause) {
    if (!controller.signal.aborted) error.value = errorText(cause)
  } finally {
    busy.value = ''
  }
}
// Refresh labels independently; packages without launcher activities remain visible.
async function load() {
  await refresh()
  if (props.apps.length || controller.signal.aborted) return
  const usb = requireWebUsbConnection(props.serial)
  const labels = await (
    usb ? usb.apps(controller.signal) : api.apps(props.serial).then((r) => r.apps)
  ).catch(() => [])
  if (controller.signal.aborted) return
  fallbackApps.value = labels
}
void load()
onBeforeUnmount(() => {
  controller.abort()
  detailRequest?.abort()
})
</script>
<template>
  <WindowFrame
    id="app-manager"
    title="应用管理"
    titlebar-class="developer-window-toolbar"
    resize-class="file-resize-handle"
    :geometry="{
      size: { width: 900, height: 640 },
      minSize: { width: 440, height: 400 },
      titlebarHeight: 44,
      mobileFullscreen: true,
    }"
    @close="emit('close')"
  >
    <template #titlebar>
      <strong class="developer-window-title">应用管理</strong>
    </template>
    <div class="workbench-content">
      <div class="flex flex-wrap gap-2">
        <Input
          v-model="query"
          aria-label="搜索已安装应用"
          placeholder="搜索应用名称或包名"
          class="min-w-48 flex-1"
        />
        <Button variant="outline" :disabled="loading || !!busy" @click="refresh">
          <RefreshCw data-icon="inline-start" />
          刷新
        </Button>
        <Button @click="emit('install')">安装 APK</Button>
      </div>
      <ToggleGroup
        :model-value="filter"
        type="single"
        variant="outline"
        aria-label="应用筛选"
        class="justify-start"
        @update:model-value="
          (value) => {
            if (value) filter = String(value)
          }
        "
      >
        <ToggleGroupItem value="all">全部</ToggleGroupItem>
        <ToggleGroupItem value="user">用户应用</ToggleGroupItem>
        <ToggleGroupItem value="system">系统应用</ToggleGroupItem>
        <ToggleGroupItem value="disabled">已停用</ToggleGroupItem>
      </ToggleGroup>
      <div v-if="error" class="workbench-feedback">
        <p role="alert" class="text-sm text-destructive whitespace-pre-wrap">{{ error }}</p>
      </div>
      <div class="app-manager-columns">
        <div class="app-manager-list" aria-label="已安装应用">
          <Button
            v-for="app in visible"
            :key="app.package"
            :variant="selected === app.package ? 'secondary' : 'ghost'"
            class="app-manager-row"
            :disabled="!!busy"
            @click="selected = app.package"
          >
            <AppIcon :name="app.name" :package="app.package" :icon-url="app.iconUrl" />
            <span class="flex min-w-0 flex-1 flex-col gap-1">
              <span class="truncate">{{ app.name }}</span>
              <small class="truncate">
                {{ app.package }} · {{ app.system ? '系统' : '用户'
                }}{{ app.disabled ? ' · 已停用' : '' }}
              </small>
            </span>
          </Button>
          <Empty v-if="!loading && !visible.length">
            <EmptyHeader>
              <EmptyTitle>没有匹配的应用</EmptyTitle>
              <EmptyDescription>调整搜索条件或刷新应用列表。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
        <section v-if="current" class="app-manager-detail" :aria-busy="detailLoading">
          <div class="flex items-center gap-3">
            <AppIcon :name="current.name" :package="current.package" :icon-url="current.iconUrl" />
            <div class="min-w-0">
              <h3 class="break-all">{{ current.name }}</h3>
              <p class="text-sm text-muted-foreground break-all">{{ current.package }}</p>
            </div>
          </div>
          <div class="flex flex-wrap gap-2">
            <Button size="sm" :disabled="!!busy || current.disabled" @click="run('app-launch')">
              启动
            </Button>
            <Button size="sm" variant="outline" :disabled="!!busy" @click="run('app-stop')">
              强制停止
            </Button>
            <Button size="sm" variant="outline" :disabled="!!busy" @click="run('app-settings')">
              应用设置
            </Button>
            <Button
              v-if="current.disabled"
              size="sm"
              variant="outline"
              :disabled="!!busy"
              @click="run('app-enable')"
            >
              启用应用
            </Button>
            <Button
              v-else
              size="sm"
              variant="outline"
              :disabled="!!busy"
              @click="
                confirm(
                  'app-disable',
                  '停用应用',
                  '将为当前 Android 用户停用该应用，可在已停用列表恢复。',
                )
              "
            >
              停用应用
            </Button>
            <Button
              size="sm"
              variant="destructive"
              :disabled="!!busy"
              @click="
                confirm('app-clear', '清除应用数据', '登录状态、设置和应用数据将被清除，无法撤销。')
              "
            >
              清除数据
            </Button>
            <Button
              size="sm"
              variant="destructive"
              :disabled="!!busy"
              @click="
                confirm(
                  'app-uninstall',
                  '卸载应用',
                  current.system
                    ? '将为当前 Android 用户移除此系统应用及其数据。'
                    : '将为当前 Android 用户卸载应用并删除其数据。',
                )
              "
            >
              卸载
            </Button>
          </div>
          <dl class="workbench-details">
            <dt>版本</dt>
            <dd>{{ details.version }} ({{ details.code }})</dd>
            <dt>首次安装</dt>
            <dd>{{ details.installed }}</dd>
            <dt>最近更新</dt>
            <dd>{{ details.updated }}</dd>
            <dt>最低 / 目标 SDK</dt>
            <dd>{{ details.minSdk }} / {{ details.targetSdk }}</dd>
            <dt>安装路径</dt>
            <dd>{{ details.path }}</dd>
          </dl>
          <section v-if="paths.length" class="flex flex-col gap-2">
            <h4>导出安装包</h4>
            <p v-if="paths.length > 1" class="text-sm text-muted-foreground">
              此应用有 {{ paths.length }} 个分包，重新安装时需一起选择。
            </p>
            <Button
              v-for="(path, index) in paths"
              :key="path"
              variant="outline"
              size="sm"
              :disabled="!!busy"
              @click="exportFile(index)"
            >
              <Download data-icon="inline-start" />
              <span class="truncate">{{ path.split('/').at(-1) }}</span>
            </Button>
          </section>
          <details v-if="raw">
            <summary>完整应用信息与权限</summary>
            <pre class="workbench-raw">{{ raw }}</pre>
          </details>
        </section>
        <Empty v-else>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Package />
            </EmptyMedia>
          </EmptyHeader>
        </Empty>
      </div>
    </div>
    <ConfirmOperation
      v-model:open="confirmOpen"
      :title="pending?.title || ''"
      :description="pending?.description || ''"
      @confirm="pending && run(pending.operation, pending.pkg)"
    />
  </WindowFrame>
</template>
