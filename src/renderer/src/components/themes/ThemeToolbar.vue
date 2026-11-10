<script setup lang="ts">
import { FolderOpenIcon, PlusIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { useThemeActions } from '@/composables/useThemeActions'
import { useAppStore } from '@/stores/app'

/** New theme and the themes folder: in the head of the settings' Theme card. */
const app = useAppStore()
const actions = useThemeActions()

const folder = computed(() => {
  const dir = app.info?.userDataDir
  return dir ? `${dir}${dir.includes('/') ? '/' : '\\'}themes` : ''
})
</script>

<template>
  <div class="flex items-center gap-2">
    <Button size="sm" variant="outline" @click="actions.createNew()">
      <PlusIcon data-icon="inline-start" />
      Neues Theme
    </Button>
    <Button size="sm" variant="outline" v-tooltip="folder" @click="actions.openFolder()">
      <FolderOpenIcon data-icon="inline-start" />
      Ordner öffnen
    </Button>
  </div>
</template>
