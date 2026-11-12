<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { handleMarkdownClick, loadFenceLanguages, useMarkdown } from '@/composables/useMarkdown'

/** `breaks`: every line break counts, as in what a user typed. */
const props = defineProps<{ source: string; breaks?: boolean }>()
const { render } = useMarkdown(props.breaks)
// Rendered again once the languages of its code blocks are loaded.
const languagesLoaded = ref(0)
watch(
  () => props.source,
  (source) => {
    void loadFenceLanguages(source).then((loaded) => {
      if (loaded) languagesLoaded.value++
    })
  },
  { immediate: true },
)
const html = computed(() => {
  void languagesLoaded.value
  return render(props.source)
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- markdown-it runs with html:false, output is escaped -->
  <div class="markdown syntax selectable" @click="handleMarkdownClick" v-html="html" />
</template>
