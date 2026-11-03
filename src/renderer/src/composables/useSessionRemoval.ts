import { toast } from 'vue-sonner'
import type { SessionSummary } from '@shared/types'
import { toastError } from '@/lib/errors'
import { formatBytes } from '@/lib/format'
import { useSessionsStore } from '@/stores/sessions'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import { sessionKey } from './useSessionSearch'

function sessionsLabel(count: number): string {
  return count === 1 ? '1 Session' : `${count} Sessions`
}

/** Moves sessions to the recycle bin after asking; sessions open in a tab stay. */
export function useSessionRemoval() {
  const sessions = useSessionsStore()
  const terminals = useTerminalsStore()
  const ui = useUiStore()

  /** Resolves to true once sessions were removed. */
  async function remove(list: SessionSummary[]): Promise<boolean> {
    if (list.length === 0 || sessions.removing) return false
    // A tab may resume its session later, also after it ended.
    const inTabs = new Set(
      terminals.terminals.flatMap((t) =>
        [t.sessionId, t.resumeSessionId].filter((id) => id !== null).map((id) => sessionKey(t.accountId, id)),
      ),
    )
    const targets = list.filter((s) => !inTabs.has(sessionKey(s.accountId, s.id)))
    const kept = list.length - targets.length
    if (targets.length === 0) {
      toast.info(list.length === 1 ? 'Die Session ist in einem Tab offen' : 'Die Sessions sind in Tabs offen', {
        description: 'Schließe den Tab zuerst, dann lässt sie sich löschen.',
      })
      return false
    }

    const bytes = formatBytes(targets.reduce((sum, s) => sum + s.sizeBytes, 0))
    const single = targets.length === 1 ? targets[0] : null
    const description = [
      single
        ? `„${single.title}“ kommt mit Verlauf, Subagents und /rewind-Ständen in den Papierkorb (${bytes}).`
        : `Die Verläufe kommen mit Subagents und /rewind-Ständen in den Papierkorb (${bytes}).`,
      'Fortsetzen lässt sich eine Session erst wieder, wenn du sie dort wiederherstellst.',
      kept > 0 ? `${sessionsLabel(kept)} ${kept === 1 ? 'ist' : 'sind'} in einem Tab offen und ${kept === 1 ? 'bleibt' : 'bleiben'}.` : '',
    ]
      .filter(Boolean)
      .join(' ')
    const confirmed = await ui.confirm({
      title: single ? 'Session löschen?' : `${sessionsLabel(targets.length)} löschen?`,
      description,
      confirmText: 'In den Papierkorb',
      destructive: true,
    })
    if (!confirmed) return false

    try {
      const result = await sessions.remove(targets.map((s) => ({ accountId: s.accountId, sessionId: s.id })))
      const busy = result.inUse.length
      if (result.removed.length > 0) {
        toast.success(
          result.removed.length === 1 ? 'Session gelöscht' : `${sessionsLabel(result.removed.length)} gelöscht`,
          {
            description: [
              `${formatBytes(result.removedBytes)} im Papierkorb`,
              busy > 0 ? `${sessionsLabel(busy)} ${busy === 1 ? 'läuft' : 'laufen'} gerade in Claude Code und ${busy === 1 ? 'bleibt' : 'bleiben'}` : '',
            ]
              .filter(Boolean)
              .join(' · '),
          },
        )
      } else if (busy > 0) {
        toast.info(busy === 1 ? 'Die Session läuft gerade in Claude Code' : 'Die Sessions laufen gerade in Claude Code', {
          description: 'Beende Claude Code dort, dann lässt sie sich löschen.',
        })
      }
      if (result.failed.length > 0) {
        toast.error(`${sessionsLabel(result.failed.length)} nicht gelöscht`, { description: result.error ?? undefined })
      }
      return result.removed.length > 0
    } catch (error) {
      toastError(error, 'Sessions konnten nicht gelöscht werden')
      return false
    }
  }

  return { remove }
}
