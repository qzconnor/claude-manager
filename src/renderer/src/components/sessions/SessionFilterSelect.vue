<script setup lang="ts">
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'

/** A filter of the session list: „all“ plus groups of options, e.g. newer than / older than. */
defineProps<{
  label: string
  allLabel: string
  groups: { value: string; label: string }[][]
}>()
const model = defineModel<string>({ required: true })
</script>

<template>
  <Select v-model="model">
    <SelectTrigger size="sm" class="w-full min-w-0" :aria-label="label">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectGroup>
        <SelectItem value="all">{{ allLabel }}</SelectItem>
      </SelectGroup>
      <template v-for="options in groups" :key="options[0]?.value">
        <SelectSeparator />
        <SelectGroup>
          <SelectItem v-for="option in options" :key="option.value" :value="option.value">
            {{ option.label }}
          </SelectItem>
        </SelectGroup>
      </template>
    </SelectContent>
  </Select>
</template>
