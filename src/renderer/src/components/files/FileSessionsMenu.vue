<script setup lang="ts">
import { HistoryIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { SessionFileEdit, SessionSummary, TerminalInfo } from '@shared/types'
import AccountDot from '@/components/common/AccountDot.vue'
import {
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu'
import { Spinner } from '@/components/ui/spinner'
import { errorMessage } from '@/lib/errors'
import { formatDateTime, formatRelative } from '@/lib/format'
import { useAccountsStore } from '@/stores/accounts'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'

/**
 * „Von Sessions geändert“ in a file's context menu: the sessions whose Claude changed the file, loaded
 * when the submenu opens. One that runs in a tab shows that tab, any other its conversation.
 */
const props = defineProps<{ path: string }>()

const accounts = useAccountsStore()
const terminals = useTerminalsStore()
const ui = useUiStore()
const router = useRouter()

const edits = ref<SessionFileEdit[] | null>(null)
const error = ref<string | null>(null)
let request = 0

async function load() {
  const asked = ++request
  const path = props.path
  error.value = null
  try {
    const found = await window.api.sessions.editedBy(path)
    if (asked === request) edits.value = found
  } catch (cause) {
    if (asked === request) error.value = errorMessage(cause)
  }
}

function onOpen(open: boolean) {
  if (open) void load()
}

const several = computed(() => accounts.accounts.length > 1)

function tabOf(session: SessionSummary): TerminalInfo | null {
  return (
    terminals.terminals.find(
      (t) => t.mode === 'session' && t.status === 'running' && t.accountId === session.accountId && t.sessionId === session.id,
    ) ?? null
  )
}

function show(session: SessionSummary) {
  const tab = tabOf(session)
  if (tab) {
    terminals.activate(tab.id)
    // In groups the route follows the tab by itself.
    if (router.currentRoute.value.name !== 'terminals') void router.push({ name: 'terminals' })
    return
  }
  ui.sessionToShow = { accountId: session.accountId, sessionId: session.id, query: '' }
  void router.push({ name: 'sessions' })
}

function hint(edit: SessionFileEdit): string {
  const account = accounts.get(edit.session.accountId)?.name
  return [edit.session.title, account, `zuletzt geändert ${formatDateTime(edit.changedAt)}`].filter(Boolean).join('\n')
}
</script>

<template>
  <ContextMenuSub @update:open="onOpen">
    <ContextMenuSubTrigger>
      <HistoryIcon />
      Von Sessions geändert
    </ContextMenuSubTrigger>
    <ContextMenuSubContent class="w-80 max-w-[calc(100vw-2rem)]">
      <ContextMenuItem v-if="error" disabled class="text-destructive">Konnte nicht gesucht werden: {{ error }}</ContextMenuItem>
      <ContextMenuItem v-else-if="!edits" disabled>
        <Spinner class="size-[14px]" />
        Wird gesucht …
      </ContextMenuItem>
      <ContextMenuItem v-else-if="!edits.length" disabled>Keine Session hat sie mit Claude geändert</ContextMenuItem>
      <template v-else>
        <ContextMenuItem
          v-for="edit in edits"
          :key="`${edit.session.accountId}:${edit.session.id}`"
          :title="hint(edit)"
          @select="show(edit.session)"
        >
          <AccountDot v-if="several" :color="accounts.get(edit.session.accountId)?.color" />
          <span class="min-w-0 flex-1 truncate">{{ edit.session.title }}</span>
          <ContextMenuShortcut class="shrink-0">
            {{ tabOf(edit.session) ? 'im Tab · ' : '' }}{{ formatRelative(edit.changedAt) }}
          </ContextMenuShortcut>
        </ContextMenuItem>
      </template>
    </ContextMenuSubContent>
  </ContextMenuSub>
</template>
