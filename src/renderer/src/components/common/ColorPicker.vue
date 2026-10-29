<script setup lang="ts">
import { CheckIcon } from '@lucide/vue'
import { ACCOUNT_COLORS } from '@shared/defaults'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

const model = defineModel<string>({ required: true })

function onUpdate(value: unknown) {
  if (typeof value === 'string' && value) model.value = value
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <ToggleGroup type="single" :spacing="1" :model-value="model" aria-label="Farbe" @update:model-value="onUpdate">
      <ToggleGroupItem v-for="color in ACCOUNT_COLORS" :key="color" :value="color" :aria-label="color" size="sm">
        <span class="flex size-4 items-center justify-center rounded-full" :style="{ backgroundColor: color }">
          <CheckIcon v-if="model.toLowerCase() === color" class="size-3 text-black/70" />
        </span>
      </ToggleGroupItem>
    </ToggleGroup>
    <label class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
      <input v-model="model" type="color" class="size-6 cursor-pointer rounded-md border-0 bg-transparent p-0" />
      Eigene
    </label>
  </div>
</template>
