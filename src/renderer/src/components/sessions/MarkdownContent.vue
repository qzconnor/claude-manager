<script setup lang="ts">
import { computed } from 'vue'
import { handleMarkdownClick, useMarkdown } from '@/composables/useMarkdown'

const props = defineProps<{ source: string }>()
const { render } = useMarkdown()
const html = computed(() => render(props.source))
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- markdown-it runs with html:false, output is escaped -->
  <div class="markdown selectable" @click="handleMarkdownClick" v-html="html" />
</template>
