<script setup lang="ts">
import { ChevronRightIcon, CircleArrowDownIcon, SearchIcon, SearchXIcon, XIcon } from '@lucide/vue'
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, ref, watch, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { searchTerms } from '@shared/utils'
import HighlightText from '@/components/common/HighlightText.vue'
import PageContainer from '@/components/common/PageContainer.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import SettingsAbout from '@/components/settings/SettingsAbout.vue'
import SettingsApi from '@/components/settings/SettingsApi.vue'
import SettingsAppearance from '@/components/settings/SettingsAppearance.vue'
import SettingsClaude from '@/components/settings/SettingsClaude.vue'
import SettingsNotifications from '@/components/settings/SettingsNotifications.vue'
import SettingsTerminal from '@/components/settings/SettingsTerminal.vue'
import SettingsTools from '@/components/settings/SettingsTools.vue'
import SettingsTransfer from '@/components/settings/SettingsTransfer.vue'
import SettingsUpdates from '@/components/settings/SettingsUpdates.vue'
import { SETTINGS_TAB_ICONS } from '@/components/settings/settings-tabs'
import { Card } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { provideSettingsFilter, revealSetting, SETTINGS, settingsEntry } from '@/composables/useSettingsSearch'
import { matchSettings, SETTINGS_TAB_LABELS, type SettingsEntry } from '@/lib/settings-index'
import { SETTINGS_TABS, type SettingsTab } from '@/router'
import { useUiStore } from '@/stores/ui'
import { useUpdatesStore } from '@/stores/updates'

const route = useRoute()
const router = useRouter()
const ui = useUiStore()
const updates = useUpdatesStore()

const PAGES: Record<SettingsTab, Component> = {
  appearance: SettingsAppearance,
  terminal: SettingsTerminal,
  claude: SettingsClaude,
  tools: SettingsTools,
  notifications: SettingsNotifications,
  api: SettingsApi,
  updates: SettingsUpdates,
  about: SettingsAbout,
}

const tabs = computed(() =>
  SETTINGS_TABS.map((value) => ({
    value,
    label: SETTINGS_TAB_LABELS[value],
    icon: value === 'updates' && updates.hasUpdate ? CircleArrowDownIcon : SETTINGS_TAB_ICONS[value],
  })),
)

const isTab = (value: unknown): value is SettingsTab => SETTINGS_TABS.includes(value as SettingsTab)

/**
 * The tab can be asked for with `?tab=` (e.g. the updates from a notification). Without it the
 * page shows the tab it had last – it stays alive in the background while other pages are open.
 */
const tab = ref<SettingsTab>('appearance')
watch(
  () => (route.name === 'settings' ? route.query.tab : undefined),
  (asked) => {
    if (isTab(asked)) tab.value = asked
  },
  { immediate: true },
)

function select(value: unknown) {
  if (!isTab(value) || value === tab.value) return
  tab.value = value
  if (route.name === 'settings') void router.replace({ query: { ...route.query, tab: value } })
}

/**
 * The search goes through all tabs at once: instead of the tabs the page shows every card and row
 * that matches, with their controls. Tabs without controls (updates, info) list links instead.
 */
const query = ref('')
const terms = computed(() => searchTerms(query.value))
const match = computed(() => matchSettings(SETTINGS, terms.value))
provideSettingsFilter(terms, match)

const results = computed(() => {
  const found = match.value
  if (!found) return []
  return tabs.value
    .filter((item) => found.tabs.includes(item.value))
    .map((item) => ({ ...item, links: SETTINGS.filter((entry) => entry.tab === item.value && entry.linked && found.ids.has(entry.id)) }))
})

const SEARCH_ID = 'settings-search'
function focusSearch() {
  const input = document.getElementById(SEARCH_ID)
  if (input instanceof HTMLInputElement) {
    input.focus()
    input.select()
  }
}
/** The app's search key (Strg+Umschalt+F), and here, without a terminal to keep it, Strg+F too. */
watch(() => ui.settingsSearchRequest, focusSearch)
useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (route.name !== 'settings' || event.key.toLowerCase() !== 'f' || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
  event.preventDefault()
  focusSearch()
})

function onSearchEscape(event: KeyboardEvent) {
  if (query.value) query.value = ''
  else (event.target as HTMLElement).blur()
}

/** Shows a card or row in its tab: ends the search, opens the tab and scrolls there. */
async function reveal(entry: SettingsEntry) {
  query.value = ''
  tab.value = entry.tab
  if (route.name === 'settings') void router.replace({ query: { ...route.query, setting: undefined, tab: entry.tab } })
  await nextTick()
  await revealSetting(entry)
}

/** `?setting=<anchor>`: from the command palette. Taken out of the address again, so it works twice in a row. */
watch(
  () => (route.name === 'settings' ? route.query.setting : undefined),
  (id) => {
    if (typeof id !== 'string') return
    const entry = settingsEntry(id)
    if (entry) void reveal(entry)
    else void router.replace({ query: { ...route.query, setting: undefined } })
  },
  { immediate: true },
)
</script>

<template>
  <PageContainer class="max-w-4xl">
    <PageHeader title="Einstellungen" description="Änderungen werden sofort übernommen und gespeichert.">
      <template #actions>
        <InputGroup class="w-64">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            :id="SEARCH_ID"
            v-model="query"
            placeholder="Einstellungen suchen"
            aria-label="Einstellungen suchen"
            spellcheck="false"
            @keydown.esc="onSearchEscape"
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton v-if="query" size="icon-xs" aria-label="Suche leeren" @click="query = ''">
              <XIcon />
            </InputGroupButton>
            <Kbd v-else>Strg+F</Kbd>
          </InputGroupAddon>
        </InputGroup>
        <SettingsTransfer />
      </template>
    </PageHeader>

    <div v-if="match" class="flex flex-col gap-8">
      <section v-for="result in results" :key="result.value" class="flex flex-col gap-4" :aria-label="result.label">
        <h2 class="flex items-center gap-2 font-heading text-base font-semibold">
          <component :is="result.icon" class="size-4.5 text-muted-foreground" />
          {{ result.label }}
        </h2>
        <Card v-if="result.links.length" class="gap-0 py-1.5">
          <button
            v-for="entry in result.links"
            :key="entry.id"
            type="button"
            class="mx-1.5 flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            @click="reveal(entry)"
          >
            <span class="min-w-0 flex-1 truncate font-medium"><HighlightText :text="entry.label" :terms="terms" /></span>
            <span class="text-xs text-muted-foreground">Anzeigen</span>
            <ChevronRightIcon class="size-4 text-muted-foreground" />
          </button>
        </Card>
        <component :is="PAGES[result.value]" v-else />
      </section>

      <Empty v-if="!results.length" class="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchXIcon />
          </EmptyMedia>
          <EmptyTitle>Keine Einstellung gefunden</EmptyTitle>
          <EmptyDescription>Nichts passt zu „{{ query.trim() }}“.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>

    <Tabs v-else :model-value="tab" class="gap-6" @update:model-value="select">
      <TabsList
        variant="line"
        class="w-full justify-start gap-0 overflow-x-auto rounded-none p-0 shadow-[inset_0_-1px_0_var(--color-border)] [scrollbar-width:none] group-data-horizontal/tabs:h-auto"
      >
        <TabsTrigger
          v-for="item in tabs"
          :key="item.value"
          :value="item.value"
          class="h-11 shrink-0 gap-2 rounded-none rounded-t-md px-3 text-[0.9375rem] hover:bg-muted/50 group-data-horizontal/tabs:after:bottom-0 after:bg-primary [&_svg:not([class*=size-])]:size-4.5"
        >
          <component :is="item.icon" :class="item.value === 'updates' && updates.hasUpdate && 'text-success'" />
          {{ item.label }}
          <template v-if="item.value === 'updates'">
            <span v-if="updates.hasUpdate" class="relative flex size-2" aria-label="Update verfügbar">
              <span class="absolute size-full animate-ping rounded-full bg-success opacity-75" />
              <span class="relative size-2 rounded-full bg-success" />
            </span>
            <span v-else-if="updates.unseen" class="size-2 rounded-full bg-success" aria-label="Neue Versionshinweise" />
          </template>
        </TabsTrigger>
      </TabsList>
      <TabsContent v-for="item in tabs" :key="item.value" :value="item.value">
        <component :is="PAGES[item.value]" />
      </TabsContent>
    </Tabs>
  </PageContainer>
</template>
