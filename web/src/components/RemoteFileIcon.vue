<script setup lang="ts">
import { computed } from 'vue'
import archiveIcon from '@/assets/files/archive.svg'
import fileIcon from '@/assets/files/file.svg'
import audioIcon from '@/assets/files/audio.svg'
import imageIcon from '@/assets/files/image.svg'
import documentIcon from '@/assets/files/document.svg'
import videoIcon from '@/assets/files/video.svg'
import apkIcon from '@/assets/files/apk.svg'
import folderIcon from '@/assets/remote-folder.svg'
import { remoteFileKind, type RemoteFileKind } from '@/services/files'

const props = defineProps<{ name: string; isDir: boolean }>()
const kind = computed(() => remoteFileKind(props.name, props.isDir))
const icons: Record<RemoteFileKind, string> = {
  folder: folderIcon,
  image: imageIcon,
  video: videoIcon,
  audio: audioIcon,
  archive: archiveIcon,
  apk: apkIcon,
  document: documentIcon,
  file: fileIcon,
}
</script>

<template>
  <span class="file-kind-icon" :data-kind="kind" aria-hidden="true">
    <img :src="icons[kind]" alt="" draggable="false" />
  </span>
</template>
