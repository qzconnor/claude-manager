<script setup lang="ts">
import { GlobeIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useBrowsersStore } from '@/stores/browsers'

/** The icon of the page in a browser tab, a globe while it has none. Sized by its class. */
const props = defineProps<{ terminalId: string }>()

const browsers = useBrowsersStore()
const src = computed(() => browsers.get(props.terminalId)?.state.favicon ?? null)
/** An image Chromium can't draw after all, e.g. a broken `.ico`. */
const broken = ref(false)
watch(src, () => (broken.value = false))
</script>

<template>
  <img v-if="src && !broken" :src="src" alt="" draggable="false" class="object-contain" @error="broken = true" />
  <GlobeIcon v-else />
</template>
