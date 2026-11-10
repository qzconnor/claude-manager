<script setup lang="ts">
import { GlobeIcon, XIcon } from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import { addressToUrl, BLANK_PAGE } from '@shared/browser'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useLauncher } from '@/composables/useLauncher'
import { useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'

/**
 * The browser tab while its session has no page yet: an address opens the session's first one. Claude
 * opens one here as well, as soon as it uses the browser. Without a session it offers to close the tab.
 */
const props = defineProps<{ active: boolean }>()

const terminals = useTerminalsStore()
const launcher = useLauncher()
const ui = useUiStore()
const { containerBackground } = useTerminalAppearance()

const session = computed(() => terminals.browserSession)
const address = ref('')
const input = ref<HTMLInputElement | null>(null)

function submit() {
  if (!session.value || !address.value.trim()) return
  const url = addressToUrl(address.value)
  if (url === BLANK_PAGE) return
  void launcher.newPage(session.value.id, url)
  address.value = ''
}

function focusInput() {
  void nextTick(() => input.value?.focus())
}

watch(
  () => props.active && !!session.value,
  (ready) => {
    if (ready) focusInput()
  },
  { immediate: true },
)
watch(
  () => ui.focusTerminalRequest,
  () => {
    if (props.active) focusInput()
  },
)
</script>

<template>
  <Empty class="rounded-none border-0" :style="{ background: containerBackground }">
    <EmptyHeader>
      <EmptyMedia>
        <GlobeIcon class="size-8 text-muted-foreground opacity-60" />
      </EmptyMedia>
      <EmptyTitle>{{ session ? `Noch kein Browser für „${session.title}“` : 'Keine Session offen' }}</EmptyTitle>
      <EmptyDescription>
        <template v-if="session">Gib eine Adresse ein. Benutzt Claude den Browser, öffnet er sich auch hier.</template>
        <template v-else>Sobald du in einer Session arbeitest, zeigt der Browser hier ihre Seiten.</template>
      </EmptyDescription>
    </EmptyHeader>
    <EmptyContent v-if="!session">
      <Button variant="outline" size="sm" @click="terminals.closeBrowserTab()">
        <XIcon data-icon="inline-start" />
        Browser schließen
      </Button>
    </EmptyContent>
    <EmptyContent v-else class="w-full max-w-md">
      <form class="w-full" @submit.prevent="submit">
        <input
          ref="input"
          v-model="address"
          type="text"
          aria-label="Adresse"
          placeholder="Adresse eingeben oder suchen"
          spellcheck="false"
          autocomplete="off"
          class="h-9 w-full rounded-md border border-input bg-background/40 px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"
        />
      </form>
    </EmptyContent>
  </Empty>
</template>
