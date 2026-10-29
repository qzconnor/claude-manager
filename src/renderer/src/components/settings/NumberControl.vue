<script setup lang="ts">
import {
  NumberField,
  NumberFieldContent,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput,
} from '@/components/ui/number-field'

defineProps<{ id?: string; min?: number; max?: number; step?: number }>()
const model = defineModel<number>({ required: true })

function onUpdate(value: number | undefined) {
  if (typeof value === 'number' && Number.isFinite(value)) model.value = value
}
</script>

<template>
  <NumberField
    :id="id"
    :model-value="model"
    :min="min"
    :max="max"
    :step="step ?? 1"
    :format-options="{ useGrouping: false, maximumFractionDigits: 2 }"
    locale="de"
    class="w-32"
    @update:model-value="onUpdate"
  >
    <NumberFieldContent>
      <NumberFieldDecrement />
      <NumberFieldInput />
      <NumberFieldIncrement />
    </NumberFieldContent>
  </NumberField>
</template>
