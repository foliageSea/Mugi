<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { computed } from 'vue'
import { X } from '@lucide/vue'
import { reactiveOmit } from '@vueuse/core'
import { DialogClose, DialogContent, DialogPortal, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'
import DialogOverlay from './DialogOverlay.vue'

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  defineProps<
    DialogContentProps & {
      class?: HTMLAttributes['class']
      showCloseButton?: boolean
      showOverlay?: boolean
      portalled?: boolean
      portalTo?: string | HTMLElement
      variant?: 'default' | 'launcher' | 'control-center'
    }
  >(),
  {
    showCloseButton: true,
    showOverlay: true,
    portalled: true,
    variant: 'default',
  },
)
const emits = defineEmits<DialogContentEmits>()

const delegatedProps = reactiveOmit(
  props,
  'class',
  'showCloseButton',
  'showOverlay',
  'portalled',
  'portalTo',
  'variant',
)

const forwarded = useForwardPropsEmits(delegatedProps, emits)
const contentClass = computed(() =>
  cn(
    'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed z-50 grid w-full max-w-[calc(100%-2rem)] gap-4 rounded-lg border p-6 shadow-lg duration-200',
    props.variant === 'launcher'
      ? 'launcher-dialog'
      : props.variant === 'control-center'
        ? 'control-center-dialog'
        : 'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 top-[50%] left-[50%] translate-x-[-50%] translate-y-[-50%] sm:max-w-lg',
    props.class,
  ),
)
</script>

<template>
  <DialogPortal :disabled="!portalled" :to="portalTo">
    <DialogOverlay v-if="showOverlay" />
    <DialogContent
      data-slot="dialog-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="contentClass"
    >
      <slot />

      <DialogClose
        v-if="showCloseButton"
        data-slot="dialog-close"
        class="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
      >
        <X />
        <span class="sr-only">关闭</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
