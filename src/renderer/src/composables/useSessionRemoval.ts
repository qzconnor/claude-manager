import { toast } from 'vue-sonner'
import type { SessionRef, SessionSummary } from '@shared/types'
import { toastError } from '@/lib/errors'
import { formatBytes } from '@/lib/format'
import { useSessionsStore } from '@/stores/sessions'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import { sessionKey } from './useSessionSearch'

/** How long „Rückgängig“ can bring deleted sessions back before they go to the recycle bin. */
export const UNDO_MS = 8000

function sessionsLabel(count: number): string {
  return count === 1 ? '1 Session' : `${count} Sessions`
}

/**
 * Moves sessions to the recycle bin; sessions open in a tab stay. They leave the lists at once and
 * go once the toast with „Rückgängig“ is gone; several at once are asked for first.
 */
export function useSessionRemoval() {
  const sessions = useSessionsStore()
  const terminals = useTerminalsStore()
  const ui = useUiStore()

  /** Resolves to true once sessions are on their way (out of the lists). */
  async function remove(list: SessionSummary[]): Promise<boolean> {
    if (list.length === 0) return false
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
    const stay =
      kept > 0 ? `${sessionsLabel(kept)} ${kept === 1 ? 'ist' : 'sind'} in einem Tab offen und ${kept === 1 ? 'bleibt' : 'bleiben'}.` : ''
    // One session goes without asking: „Rückgängig“ brings it back.
    if (list.length > 1) {
      const confirmed = await ui.confirm({
        title: single ? 'Session löschen?' : `${sessionsLabel(targets.length)} löschen?`,
        description: [
          single
            ? `„${single.title}“ kommt mit Verlauf, Subagents und /rewind-Ständen in den Papierkorb (${bytes}).`
            : `Die Verläufe kommen mit Subagents und /rewind-Ständen in den Papierkorb (${bytes}).`,
          stay,
        ]
          .filter(Boolean)
          .join(' '),
        confirmText: 'In den Papierkorb',
        destructive: true,
      })
      if (!confirmed) return false
    }

    const refs = targets.map((s): SessionRef => ({ accountId: s.accountId, sessionId: s.id }))
    sessions.hide(refs)
    let settled = false
    const undo = () => {
      if (settled) return
      settled = true
      void sessions.bringBack(refs)
    }
    const finish = () => {
      if (settled) return
      settled = true
      void moveToBin(refs)
    }
    toast(single ? 'Session gelöscht' : `${sessionsLabel(targets.length)} gelöscht`, {
      description: [single ? `„${single.title}“ kommt in den Papierkorb (${bytes}).` : `${bytes} kommen in den Papierkorb.`, stay]
        .filter(Boolean)
        .join(' '),
      duration: UNDO_MS,
      action: { label: 'Rückgängig', onClick: undo },
      onAutoClose: finish,
      onDismiss: finish,
    })
    return true
  }

  /** Deletes the sessions for good; those that stay (running in Claude Code, locked) come back to the lists. */
  async function moveToBin(refs: SessionRef[]): Promise<void> {
    try {
      const result = await sessions.remove(refs)
      const gone = new Set(result.removed.map((r) => `${r.accountId}:${r.sessionId}`))
      const stayed = refs.filter((r) => !gone.has(`${r.accountId}:${r.sessionId}`))
      if (stayed.length > 0) await sessions.bringBack(stayed)
      const busy = result.inUse.length
      if (busy > 0) {
        toast.info(
          busy === 1
            ? 'Eine Session läuft gerade in Claude Code und bleibt'
            : `${sessionsLabel(busy)} laufen gerade in Claude Code und bleiben`,
          { description: 'Beende Claude Code dort, dann lässt sie sich löschen.' },
        )
      }
      if (result.failed.length > 0) {
        toast.error(`${sessionsLabel(result.failed.length)} nicht gelöscht`, { description: result.error ?? undefined })
      }
    } catch (error) {
      await sessions.bringBack(refs)
      toastError(error, 'Sessions konnten nicht gelöscht werden')
    }
  }

  return { remove }
}
