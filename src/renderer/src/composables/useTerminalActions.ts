import { attempt } from '@/lib/errors'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore, type TerminalTab } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'

/** Tab actions that need a confirmation when a process is still running. */
export function useTerminalActions() {
  const terminals = useTerminalsStore()
  const settings = useSettingsStore()
  const ui = useUiStore()

  async function closeTerminal(id: string): Promise<void> {
    const terminal = terminals.terminals.find((t) => t.id === id)
    if (!terminal) return
    // A browser runs no process that could lose work.
    if (terminal.status === 'running' && terminal.mode !== 'browser' && settings.settings.general.confirmCloseRunning) {
      const ok = await ui.confirm({
        title: 'Terminal schließen?',
        description: `„${terminal.title}“ läuft noch. Die Session wird beendet, kann aber später über „Sessions“ fortgesetzt werden.`,
        confirmText: 'Schließen',
        destructive: true,
      })
      if (!ok) return
    }
    await attempt(() => terminals.close(id), 'Terminal konnte nicht geschlossen werden')
  }

  /** Closes every terminal of the tab, after one question for all of them that still run. */
  async function closeTab(tab: TerminalTab): Promise<void> {
    if (tab.panes.length === 1) return closeTerminal(tab.panes[0].id)
    const running = tab.panes.filter((p) => p.status === 'running' && p.mode !== 'browser')
    if (running.length > 0 && settings.settings.general.confirmCloseRunning) {
      const ok = await ui.confirm({
        title: 'Tab schließen?',
        description:
          running.length === 1
            ? `„${running[0].title}“ läuft noch. Die Session wird beendet, kann aber später über „Sessions“ fortgesetzt werden.`
            : `${running.length} Terminals laufen noch. Ihre Sessions werden beendet, können aber später über „Sessions“ fortgesetzt werden.`,
        confirmText: 'Schließen',
        destructive: true,
      })
      if (!ok) return
    }
    await attempt(() => terminals.closeTab(tab.id), 'Tab konnte nicht geschlossen werden')
  }

  async function stopTerminal(id: string): Promise<void> {
    await attempt(() => terminals.kill(id), 'Prozess konnte nicht beendet werden')
  }

  async function restartTerminal(id: string): Promise<void> {
    await attempt(() => terminals.restart(id), 'Neustart fehlgeschlagen')
  }

  return { closeTerminal, closeTab, stopTerminal, restartTerminal }
}
