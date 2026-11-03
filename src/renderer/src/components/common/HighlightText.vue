<script setup lang="ts">
import { computed } from 'vue'
import { highlightParts } from '@/lib/search'

/** Text with the words of a search marked. */
const props = defineProps<{ text: string; terms: string[] }>()
const parts = computed(() => highlightParts(props.text, props.terms))
</script>

<!-- One line, so no white space ends up between the parts. -->
<template>
  <template v-for="(part, i) in parts" :key="i"><mark v-if="part.match" class="rounded-[3px] bg-warning/30 text-inherit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
</template>
