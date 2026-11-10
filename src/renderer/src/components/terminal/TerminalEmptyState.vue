<script setup lang="ts">
import { FolderIcon, FolderOpenIcon, HistoryIcon, PlusIcon } from '@lucide/vue'
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AccountDot from '@/components/common/AccountDot.vue'
import AppLogo from '@/components/common/AppLogo.vue'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useLauncher } from '@/composables/useLauncher'
import { useRecentFolders } from '@/composables/useRecentFolders'
import { shortenPath } from '@/lib/format'
import { useAccountsStore } from '@/stores/accounts'
import { useAppStore } from '@/stores/app'

const router = useRouter()
const app = useAppStore()
const accounts = useAccountsStore()
const launcher = useLauncher()
const recent = useRecentFolders(6)

onMounted(recent.load)
</script>

<template>
  <Empty class="size-full">
    <EmptyHeader>
      <EmptyMedia>
        <AppLogo class="size-12" />
      </EmptyMedia>
      <EmptyTitle>Keine offenen Terminals</EmptyTitle>
      <EmptyDescription>
        Starte eine neue Claude-Code-Session oder setze eine frühere Session fort.
      </EmptyDescription>
    </EmptyHeader>
    <EmptyContent class="max-w-xl">
      <div class="flex flex-wrap justify-center gap-2">
        <Button @click="launcher.newSession()">
          <PlusIcon data-icon="inline-start" />
          Neue Session
        </Button>
        <Button variant="outline" @click="launcher.newSessionInFolder()">
          <FolderOpenIcon data-icon="inline-start" />
          In Ordner starten
        </Button>
        <Button variant="outline" @click="router.push({ name: 'sessions' })">
          <HistoryIcon data-icon="inline-start" />
          Session fortsetzen
        </Button>
      </div>
      <div v-if="accounts.accounts.length > 1" class="flex flex-wrap justify-center gap-1.5">
        <Button
          v-for="account in accounts.accounts"
          :key="account.id"
          size="sm"
          variant="ghost"
          @click="launcher.newSession(account.id)"
        >
          <AccountDot :color="account.color" />
          {{ account.name }}
        </Button>
      </div>
      <!-- A click starts with the standard account, like "Neue Session". -->
      <div v-if="recent.folders.value.length" class="flex w-full max-w-sm flex-col gap-0.5 text-left">
        <p class="px-2 pb-1 text-xs font-medium text-muted-foreground">Zuletzt genutzte Ordner</p>
        <button
          v-for="folder in recent.folders.value"
          :key="folder.path"
          type="button"
          v-tooltip="`Neue Session in ${folder.path}`"
          class="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-sm transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          @click="launcher.newSession(undefined, folder.path)"
        >
          <FolderIcon class="size-4 shrink-0 text-muted-foreground" />
          <span class="max-w-[60%] shrink-0 truncate">{{ folder.name }}</span>
          <span class="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
            {{ folder.parent && shortenPath(folder.parent, app.info?.homeDir) }}
          </span>
        </button>
      </div>
      <p class="flex items-center gap-2 text-xs text-muted-foreground">
        Neuer Tab
        <KbdGroup>
          <Kbd>Strg</Kbd><Kbd>Umschalt</Kbd><Kbd>T</Kbd>
        </KbdGroup>
      </p>
    </EmptyContent>
  </Empty>
</template>
