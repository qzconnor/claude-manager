<script setup lang="ts">
import { FolderOpenIcon, HistoryIcon, PlusIcon } from '@lucide/vue'
import { useRouter } from 'vue-router'
import AccountDot from '@/components/common/AccountDot.vue'
import AppLogo from '@/components/common/AppLogo.vue'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useLauncher } from '@/composables/useLauncher'
import { useAccountsStore } from '@/stores/accounts'

const router = useRouter()
const accounts = useAccountsStore()
const launcher = useLauncher()
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
      <p class="flex items-center gap-2 text-xs text-muted-foreground">
        Neuer Tab
        <KbdGroup>
          <Kbd>Strg</Kbd><Kbd>Umschalt</Kbd><Kbd>T</Kbd>
        </KbdGroup>
      </p>
    </EmptyContent>
  </Empty>
</template>
