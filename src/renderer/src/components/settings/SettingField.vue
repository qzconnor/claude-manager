<script setup lang="ts">
import HighlightText from '@/components/common/HighlightText.vue'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { useSettingsFilter } from '@/composables/useSettingsSearch'
import type { SettingsAnchor } from '@/lib/settings-index'

/**
 * A labelled settings row: label + description on the left, the control on the right.
 * `anchor`: its entry in lib/settings-index.ts, for the search and the command palette.
 */
defineProps<{ anchor: SettingsAnchor; label: string; description?: string; for?: string }>()

const filter = useSettingsFilter()
</script>

<template>
  <Field v-if="filter.shows(anchor)" orientation="horizontal" class="gap-6" :data-setting="anchor">
    <FieldContent>
      <!-- One span: the label is a flex box and would put gaps between the marked parts. -->
      <FieldLabel :for="$props.for"><span><HighlightText :text="label" :terms="filter.terms.value" /></span></FieldLabel>
      <FieldDescription v-if="description"><HighlightText :text="description" :terms="filter.terms.value" /></FieldDescription>
    </FieldContent>
    <div class="flex shrink-0 items-center justify-end gap-2" data-setting-control>
      <slot />
    </div>
  </Field>
</template>
