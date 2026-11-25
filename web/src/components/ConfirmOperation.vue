<script setup lang="ts">
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
const open = defineModel<boolean>('open', { required: true })
defineProps<{ title: string; description: string; portalTo?: string | HTMLElement }>()
const emit = defineEmits<{ confirm: [] }>()
function confirm() {
  open.value = false
  emit('confirm')
}
</script>
<template>
  <Dialog v-model:open="open">
    <DialogContent :portal-to="portalTo">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ description }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="open = false">取消</Button>
        <Button variant="destructive" @click="confirm">确认操作</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
