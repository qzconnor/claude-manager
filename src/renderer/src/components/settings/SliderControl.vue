<script setup lang="ts">
import { computed } from 'vue'
import { Slider } from '@/components/ui/slider'

/** Slider bound to a single number, with the formatted value next to it. */
const props = defineProps<{
  id?: string
  min: number
  max: number
  step?: number
  format?: (value: number) => string
}>()
const model = defineModel<number>({ required: true })

const sliderValue = computed({
  get: () => [model.value],
  set: (value: number[] | undefined) => {
    if (value && typeof value[0] === 'number') model.value = value[0]
  },
})
const label = computed(() => (props.format ? props.format(model.value) : String(model.value)))
</script>

<template>
  <div class="flex w-64 items-center gap-3">
    <Slider :id="id" v-model="sliderValue" :min="min" :max="max" :step="step ?? 1" class="flex-1" />
    <span class="w-12 text-right text-xs text-muted-foreground tabular-nums">{{ label }}</span>
  </div>
</template>
