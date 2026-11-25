<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldLabel } from '@/components/ui/field'
import { desktopADB, type DesktopADBSettings } from '@/services/api'

const path = ref('')
const settings = ref<DesktopADBSettings>()
const busy = ref(true)
const error = ref('')
const message = ref('')

onMounted(async () => {
  try {
    settings.value = await desktopADB.settings()
    path.value = settings.value.adbPath
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取 ADB 配置失败'
  } finally {
    busy.value = false
  }
})

async function save(value = path.value) {
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    settings.value = await desktopADB.save(value)
    path.value = settings.value.adbPath
    message.value = settings.value.restartRequired
      ? '已保存，请完全退出并重新打开 mugi 后生效。'
      : '已保存。'
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存 ADB 配置失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Field>
    <FieldLabel for="settings-adb-path">ADB 可执行文件路径</FieldLabel>
    <form class="grid gap-3" @submit.prevent="save()">
      <Input
        id="settings-adb-path"
        v-model="path"
        placeholder="/opt/homebrew/bin/adb"
        autocomplete="off"
        spellcheck="false"
        :disabled="busy || !settings"
        :aria-invalid="!!error"
      />
      <p v-if="settings?.activePath" class="text-muted-foreground text-xs break-all">
        当前使用：{{ settings.activePath }}
      </p>
      <p v-else-if="settings?.startupError" class="text-destructive text-xs break-all">
        当前未找到可用的 ADB，请配置正确路径并重启应用。
      </p>
      <div class="flex gap-2">
        <Button type="submit" size="sm" :disabled="busy || !settings">
          {{ busy ? '处理中…' : '校验并保存' }}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          :disabled="busy || !settings"
          @click="save('')"
        >
          恢复自动查找
        </Button>
      </div>
      <p v-if="error" role="alert" class="text-destructive text-xs break-all">{{ error }}</p>
      <p v-if="message" role="status" class="text-muted-foreground text-xs">{{ message }}</p>
      <p v-else-if="settings?.restartRequired" role="status" class="text-muted-foreground text-xs">
        ADB 配置已更改，请完全退出并重新打开 mugi 后生效。
      </p>
    </form>
  </Field>
</template>
