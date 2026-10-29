<script setup lang="ts">
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'

/** A labelled settings row: label + description on the left, the control on the right. */
defineProps<{ label: string; description?: string; for?: string }>()
</script>

<template>
  <Field orientation="horizontal" class="gap-6">
    <FieldContent>
      <FieldLabel :for="$props.for">{{ label }}</FieldLabel>
      <FieldDescription v-if="description">{{ description }}</FieldDescription>
    </FieldContent>
    <div class="flex shrink-0 items-center justify-end gap-2">
      <slot />
    </div>
  </Field>
</template>
