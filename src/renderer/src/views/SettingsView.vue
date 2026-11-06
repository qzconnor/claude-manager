<script setup lang="ts">
import { BellIcon, BotIcon, CircleArrowDownIcon, InfoIcon, PaletteIcon, PlugIcon, SparklesIcon, SquareTerminalIcon } from '@lucide/vue'
import { computed, ref, watch, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageContainer from '@/components/common/PageContainer.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import SettingsAbout from '@/components/settings/SettingsAbout.vue'
import SettingsApi from '@/components/settings/SettingsApi.vue'
import SettingsAppearance from '@/components/settings/SettingsAppearance.vue'
import SettingsClaude from '@/components/settings/SettingsClaude.vue'
import SettingsNotifications from '@/components/settings/SettingsNotifications.vue'
import SettingsTerminal from '@/components/settings/SettingsTerminal.vue'
import SettingsTransfer from '@/components/settings/SettingsTransfer.vue'
import SettingsUpdates from '@/components/settings/SettingsUpdates.vue'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SETTINGS_TABS, type SettingsTab } from '@/router'
import { useUpdatesStore } from '@/stores/updates'

const route = useRoute()
const router = useRouter()
const updates = useUpdatesStore()

const tabs = computed<{ value: SettingsTab; label: string; icon: Component }[]>(() => [
  { value: 'appearance', label: 'Darstellung', icon: PaletteIcon },
  { value: 'terminal', label: 'Terminal', icon: SquareTerminalIcon },
  { value: 'claude', label: 'Claude Code', icon: BotIcon },
  { value: 'notifications', label: 'Benachrichtigungen', icon: BellIcon },
  { value: 'api', label: 'API', icon: PlugIcon },
  { value: 'updates', label: 'Updates', icon: updates.hasUpdate ? CircleArrowDownIcon : SparklesIcon },
  { value: 'about', label: 'Info', icon: InfoIcon },
])

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
</script>

<template>
  <PageContainer class="max-w-4xl">
    <PageHeader title="Einstellungen" description="Änderungen werden sofort übernommen und gespeichert.">
      <template #actions><SettingsTransfer /></template>
    </PageHeader>
    <Tabs :model-value="tab" class="gap-6" @update:model-value="select">
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
      <TabsContent value="appearance"><SettingsAppearance /></TabsContent>
      <TabsContent value="terminal"><SettingsTerminal /></TabsContent>
      <TabsContent value="claude"><SettingsClaude /></TabsContent>
      <TabsContent value="notifications"><SettingsNotifications /></TabsContent>
      <TabsContent value="api"><SettingsApi /></TabsContent>
      <TabsContent value="updates"><SettingsUpdates /></TabsContent>
      <TabsContent value="about"><SettingsAbout /></TabsContent>
    </Tabs>
  </PageContainer>
</template>
