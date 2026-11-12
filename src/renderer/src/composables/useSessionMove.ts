import { toast } from 'vue-sonner'
import { folderKey } from '@shared/folders'
import type { SessionSummary, TerminalInfo } from '@shared/types'
import { errorMessage } from '@/lib/errors'
import { splitFolder } from '@/lib/recent-folders'
import { sessionFolder } from '@/lib/session-tree'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'

/**
 * Moves a session into another folder, as `/cd` does in Claude Code: it goes on there with its
 * conversation. One that runs in a tab starts again there; while Claude works on it, it stays.
 */
export function useSessionMove() {
  const terminals = useTerminalsStore()
  const ui = useUiStore()

  /** The tab the session runs in now, or waits to start in; null when it is in none. */
  function runningTab(session: Pick<SessionSummary, 'accountId' | 'id'>): TerminalInfo | null {
    return (
      terminals.terminals.find(
        (t) =>
          t.mode === 'session' &&
          t.status !== 'exited' &&
          t.accountId === session.accountId &&
          (t.sessionId ?? t.resumeSessionId) === session.id,
      ) ?? null
    )
  }

  /** Claude works on the session in a tab: it moves once Claude is done. */
  function working(session: Pick<SessionSummary, 'accountId' | 'id'>): boolean {
    const tab = runningTab(session)
    return !!tab && (tab.busy || tab.compacting || tab.subagents > 0)
  }

  async function move(session: SessionSummary, to: string): Promise<void> {
    const name = splitFolder(to).name || to
    if (session.cwd && folderKey(session.cwd) === folderKey(to)) {
      toast.info(`Die Session ist schon in „${name}“`)
      return
    }
    const tab = runningTab(session)
    if (tab) {
      await moveRunning(tab, to, name)
      return
    }
    try {
      await window.api.sessions.move(session.accountId, session.id, to)
      toast.success(`Die Session ist jetzt in „${name}“`, { description: 'Fortgesetzt geht sie dort weiter.' })
      ui.folderToShow = { path: to }
    } catch (error) {
      toast.error('Session nicht verschoben', { description: errorMessage(error) })
    }
  }

  /** In its tab the session starts again in the new folder; what its input holds is lost, so it asks first. */
  async function moveRunning(tab: TerminalInfo, to: string, name: string): Promise<void> {
    if (tab.busy || tab.compacting || tab.subagents > 0) {
      toast.info('Claude arbeitet gerade', { description: 'Sobald es fertig ist, lässt sich die Session verschieben.' })
      return
    }
    const confirmed = await ui.confirm({
      title: `Session nach „${name}“ verschieben?`,
      code: to,
      description:
        'Die Session startet dafür in ihrem Tab neu und geht im neuen Ordner mit ihrem Verlauf weiter. Was in ihrer Eingabe steht und noch nicht abgeschickt ist, geht verloren.',
      confirmText: 'Neu starten und verschieben',
    })
    if (!confirmed) return
    try {
      const info = await terminals.moveSession(tab.id, to)
      if (!info) return
      toast.success(`Die Session ist jetzt in „${name}“`, { description: 'Sie läuft dort in ihrem Tab weiter.' })
      ui.folderToShow = { path: to }
    } catch (error) {
      toast.error('Session nicht verschoben', { description: errorMessage(error) })
    }
  }

  /** Asks for the folder, starting where the session is. */
  async function moveElsewhere(session: SessionSummary): Promise<void> {
    const picked = await window.api.app.pickDirectory(sessionFolder(session))
    if (picked) await move(session, picked)
  }

  return { working, move, moveElsewhere }
}
