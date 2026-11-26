<script setup lang="ts">
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from 'reka-ui'
import { Button } from '@/components/ui/button'
import { useDockPosition } from '@/composables/useDockPosition'

defineOptions({ inheritAttrs: false })
defineProps<{ tooltip: string }>()
const { dockPosition } = useDockPosition()
const tooltipSides = { left: 'right', right: 'left', bottom: 'top' } as const
</script>

<template>
  <TooltipRoot>
    <TooltipTrigger as-child>
      <Button v-bind="$attrs" variant="dock" size="dock" class="dock-tooltip-trigger">
        <slot />
      </Button>
    </TooltipTrigger>
    <TooltipPortal>
      <TooltipContent
        :side="tooltipSides[dockPosition]"
        :side-offset="8"
        :collision-padding="8"
        hide-when-detached
        update-position-strategy="always"
        :aria-label="tooltip"
        class="dock-tooltip"
      >
        {{ tooltip }}
        <TooltipArrow class="dock-tooltip-arrow" />
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>

<style scoped>
/* Keep disabled buttons inert, but let them receive hover events for their label. */
.dock-tooltip-trigger:disabled {
  pointer-events: auto;
}
/* Reka forwards these classes to portalled elements without Vue’s scope attribute. */
:global(.dock-tooltip) {
  z-index: 10;
  max-width: min(16rem, var(--reka-tooltip-content-available-width, 100vw));
  padding: 5px 9px;
  border-radius: 8px;
  background: var(--popover);
  color: var(--popover-foreground);
  box-shadow: 0 3px 12px var(--glass-shadow);
  font-size: 12px;
  line-height: 1.4;
  text-align: center;
  overflow-wrap: anywhere;
}
:global(.dock-tooltip-arrow) {
  fill: var(--popover);
}
</style>
