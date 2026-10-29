import { attempt } from '@/lib/errors'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'

/** Tab actions that need a confirmation when a process is still running. */
export function useTerminalActions() {
  const terminals = useTerminalsStore()
  const settings = useSettingsStore()
  const ui = useUiStore()

  async function closeTerminal(id: string): Promise<void> {
    const terminal = terminals.terminals.find((t) => t.id === id)
    if (!terminal) return
    if (terminal.status === 'running' && settings.settings.general.confirmCloseRunning) {
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

  async function stopTerminal(id: string): Promise<void> {
    await attempt(() => terminals.kill(id), 'Prozess konnte nicht beendet werden')
  }

  async function restartTerminal(id: string): Promise<void> {
    await attempt(() => terminals.restart(id), 'Neustart fehlgeschlagen')
  }

  return { closeTerminal, stopTerminal, restartTerminal }
}
