import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { recentFolders, type FolderUse } from '@/lib/recent-folders'
import { sessionFolder } from '@/lib/session-tree'
import { useAccountsStore } from '@/stores/accounts'
import { useAppStore } from '@/stores/app'
import { useSessionsStore } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'

/** Reads the saved sessions once, quietly: without them the list only knows the open tabs. */
export function loadRecentFolders(): void {
  const sessions = useSessionsStore()
  if (!sessions.loaded) sessions.load().catch(() => undefined)
}

/**
 * The folders sessions ran in lately, from the open tabs and the saved sessions, latest first.
 * The start folders of the accounts and the app are left out: "Neue Session" opens there anyway.
 * Call `load` before the list is shown.
 */
export function useRecentFolders(limit: MaybeRefOrGetter<number>) {
  const terminals = useTerminalsStore()
  const sessions = useSessionsStore()
  const accounts = useAccountsStore()
  const settings = useSettingsStore()
  const app = useAppStore()

  const folders = computed(() => {
    const uses: FolderUse[] = []
    for (const terminal of terminals.terminals) {
      if (terminal.mode !== 'login' && terminal.mode !== 'browser') uses.push({ path: terminal.cwd, at: terminal.createdAt })
    }
    for (const group of sessions.groups) {
      for (const session of group.sessions) {
        const path = sessionFolder(session)
        if (path) uses.push({ path, at: session.updatedAt })
      }
    }
    const exclude = [
      ...accounts.accounts.map((account) => account.defaultCwd),
      settings.settings.claude.defaultCwd,
      app.info?.fallbackCwd,
    ]
    return recentFolders(uses, { limit: toValue(limit), exclude })
  })

  return { folders, load: loadRecentFolders }
}
