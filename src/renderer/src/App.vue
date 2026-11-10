<script setup lang="ts">
import { onMounted, ref } from 'vue'
import CommandPalette from '@/components/common/CommandPalette.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import DefaultFolderDialog from '@/components/common/DefaultFolderDialog.vue'
import ProjectDialog from '@/components/common/ProjectDialog.vue'
import ThemeEditorDialog from '@/components/themes/ThemeEditorDialog.vue'
import WorkspaceDialog from '@/components/common/WorkspaceDialog.vue'
import WorktreeDialog from '@/components/common/WorktreeDialog.vue'
import AppShell from '@/components/layout/AppShell.vue'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Toaster } from '@/components/ui/sonner'
import { Spinner } from '@/components/ui/spinner'
import AppTooltip from '@/components/common/AppTooltip.vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useShortcuts } from '@/composables/useShortcuts'
import { useThemeSync } from '@/composables/useThemeSync'
import { errorMessage } from '@/lib/errors'
import { useAccountsStore } from '@/stores/accounts'
import { useAppStore } from '@/stores/app'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'
import { useThemesStore } from '@/stores/themes'
import { useUpdatesStore } from '@/stores/updates'
import { useUsageStore } from '@/stores/usage'

const settings = useSettingsStore()
const accounts = useAccountsStore()
const app = useAppStore()
const terminals = useTerminalsStore()
const usage = useUsageStore()
const updates = useUpdatesStore()
const themes = useThemesStore()

const ready = ref(false)
const fatal = ref<string | null>(null)

const { theme } = useThemeSync()
useShortcuts()

onMounted(async () => {
  try {
    // Settings, themes and app info first: terminals need the Windows build, font settings and colors on mount.
    // A themes folder that can't be read leaves the built-in themes.
    await Promise.all([settings.load(), app.load(), themes.load().catch((error) => console.error('[themes] list could not be read', error))])
    await Promise.all([accounts.load(), terminals.load(), usage.load(), updates.load()])
    ready.value = true
  } catch (error) {
    fatal.value = errorMessage(error)
  }
})
</script>

<template>
  <TooltipProvider :delay-duration="400">
    <AppShell v-if="ready" />
    <div v-else class="app-drag flex h-full items-center justify-center">
      <Empty v-if="fatal">
        <EmptyHeader>
          <EmptyTitle>Start fehlgeschlagen</EmptyTitle>
          <EmptyDescription class="selectable">{{ fatal }}</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <Spinner v-else class="size-6 text-muted-foreground" />
    </div>
    <ConfirmDialog />
    <DefaultFolderDialog v-if="ready" />
    <CommandPalette v-if="ready" />
    <WorktreeDialog v-if="ready" />
    <WorkspaceDialog v-if="ready" />
    <ProjectDialog v-if="ready" />
    <ThemeEditorDialog v-if="ready" />
    <Toaster :theme="theme.mode" position="bottom-right" close-button />
    <AppTooltip />
  </TooltipProvider>
</template>
