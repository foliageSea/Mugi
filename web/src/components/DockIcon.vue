<script setup lang="ts">
import { useId } from 'vue'
import launcher from '@/assets/dock/launcher.svg'
import mirror from '@/assets/dock/mirror.svg'
import files from '@/assets/dock/files.svg'
import installer from '@/assets/dock/installer.svg'
import performance from '@/assets/dock/performance.svg'
import terminal from '@/assets/dock/terminal.svg'
import apps from '@/assets/dock/apps.svg'
import logcat from '@/assets/dock/logcat.svg'

const icons = { launcher, mirror, files, installer, performance, terminal, apps, logcat }
defineProps<{ name: keyof typeof icons | 'device' }>()

const deviceGradient = `dock-device-${useId()}`
</script>

<template>
  <svg
    v-if="name === 'device'"
    class="dock-art dock-device-art"
    viewBox="4 4 56 56"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <linearGradient
        :id="deviceGradient"
        x1="8"
        y1="4"
        x2="55"
        y2="60"
        gradientUnits="userSpaceOnUse"
      >
        <stop stop-color="var(--device-tile-top)" />
        <stop offset="1" stop-color="var(--device-tile-bottom)" />
      </linearGradient>
    </defs>
    <rect x="4" y="4" width="56" height="56" rx="14" :fill="`url(#${deviceGradient})`" />
    <rect
      x="4.75"
      y="4.75"
      width="54.5"
      height="54.5"
      rx="13.25"
      stroke="var(--device-rim)"
      stroke-width="1.5"
    />
    <path d="M45 17h6m-6 5h3" stroke="var(--device-etch)" stroke-width="2" stroke-linecap="round" />
    <rect
      x="16"
      y="13"
      width="23"
      height="38"
      rx="6"
      fill="var(--device-screen)"
      stroke="var(--device-frame)"
      stroke-width="2.75"
    />
    <path
      d="M25 18h5m-5 28h5"
      stroke="var(--device-frame)"
      stroke-width="2"
      stroke-linecap="round"
    />
    <circle
      cx="42"
      cy="40"
      r="10.25"
      fill="var(--device-badge)"
      stroke="var(--device-screen)"
      stroke-width="1.75"
    />
    <path
      d="M42 40v4.5"
      stroke="var(--device-badge-ink)"
      stroke-width="2.5"
      stroke-linecap="round"
    />
    <circle cx="42" cy="35.5" r="1.3" fill="var(--device-badge-ink)" />
  </svg>
  <img v-else class="dock-art" :src="icons[name]" alt="" aria-hidden="true" draggable="false" />
</template>

<style scoped>
.dock-device-art {
  --device-tile-top: #416bdc;
  --device-tile-bottom: #172a77;
  --device-rim: #9abaff65;
  --device-etch: #8bb3ff;
  --device-screen: #102864;
  --device-frame: #e1efff;
  --device-badge: #9bebff;
  --device-badge-ink: #0b3473;
}

:global(:root.light .dock-device-art) {
  --device-tile-top: #4a75f1;
  --device-tile-bottom: #2346b9;
  --device-rim: #15398965;
  --device-etch: #c1d5ff;
  --device-screen: #163888;
  --device-frame: #f4f8ff;
  --device-badge: #ddf8ff;
  --device-badge-ink: #123d94;
}
</style>
