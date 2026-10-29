<script setup lang="ts">
import { FolderOpenIcon } from '@lucide/vue'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'

defineProps<{ id?: string; placeholder?: string; disabled?: boolean }>()
const model = defineModel<string>({ required: true })

async function browse() {
  const dir = await window.api.app.pickDirectory(model.value || null)
  if (dir) model.value = dir
}
</script>

<template>
  <InputGroup :data-disabled="disabled || undefined">
    <InputGroupInput :id="id" v-model="model" :placeholder="placeholder" :disabled="disabled" spellcheck="false" />
    <InputGroupAddon align="inline-end">
      <InputGroupButton size="xs" :disabled="disabled" @click="browse">
        <FolderOpenIcon />
        Durchsuchen
      </InputGroupButton>
    </InputGroupAddon>
  </InputGroup>
</template>
