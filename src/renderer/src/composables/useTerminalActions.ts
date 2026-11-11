import type { TerminalInfo } from '@shared/types'
import { attempt } from '@/lib/errors'
import { BROWSER_TAB, diffOfTab, pageOfTab } from '@/lib/workspace'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore, type TerminalTab } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'

/** Tab actions that need a confirmation when a process is still running. */
export function useTerminalActions() {
  const terminals = useTerminalsStore()
  const settings = useSettingsStore()
  const ui = useUiStore()

  async function closeTerminal(id: string): Promise<void> {
    const page = pageOfTab(id)
    if (page) return terminals.closePage(page)
    if (diffOfTab(id)) return terminals.closeDiff(id)
    // The pages stay with their sessions.
    if (id === BROWSER_TAB) return terminals.closeBrowserTab()
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

  /** One question for all terminals of the list that still run; true when they may close. */
  async function confirmClosing(list: TerminalInfo[], title: string): Promise<boolean> {
    const running = list.filter((t) => t.status === 'running' && t.mode !== 'browser')
    if (running.length === 0 || !settings.settings.general.confirmCloseRunning) return true
    return ui.confirm({
      title,
      description:
        running.length === 1
          ? `„${running[0].title}“ läuft noch. Die Session wird beendet, kann aber später über „Sessions“ fortgesetzt werden.`
          : `${running.length} Terminals laufen noch. Ihre Sessions werden beendet, können aber später über „Sessions“ fortgesetzt werden.`,
      confirmText: 'Schließen',
      destructive: true,
    })
  }

  /** In one tab bar, closes every terminal of the tab, after one question for all of them that still run. */
  async function closeTab(tab: TerminalTab): Promise<void> {
    if (tab.panes.length === 1) return closeTerminal(tab.panes[0].id)
    if (!(await confirmClosing(tab.panes, 'Tab schließen?'))) return
    await attempt(() => terminals.closeTab(tab.id), 'Tab konnte nicht geschlossen werden')
  }

  /** In one tab bar, closes the other tabs, after one question for all their terminals that still run. */
  async function closeOtherTabs(keep: TerminalTab): Promise<void> {
    const others = terminals.tabs.filter((tab) => tab.id !== keep.id)
    if (others.length === 0) return
    if (others.length === 1) return closeTab(others[0])
    if (!(await confirmClosing(others.flatMap((tab) => tab.panes), 'Andere Tabs schließen?'))) return
    await attempt(() => Promise.all(others.map((tab) => terminals.closeTab(tab.id))), 'Tabs konnten nicht geschlossen werden')
  }

  /** With the tabs in groups, closes several tabs (terminals and pages), after one question for all terminals that still run. */
  async function closeTabs(ids: string[]): Promise<void> {
    if (ids.length === 1) return closeTerminal(ids[0])
    const list = terminals.terminals.filter((t) => ids.includes(t.id))
    if (!(await confirmClosing(list, 'Tabs schließen?'))) return
    for (const id of ids) {
      const page = pageOfTab(id)
      if (page) terminals.closePage(page)
      else if (diffOfTab(id)) terminals.closeDiff(id)
      else if (id === BROWSER_TAB) terminals.closeBrowserTab()
    }
    await attempt(() => Promise.all(list.map((t) => terminals.close(t.id))), 'Tabs konnten nicht geschlossen werden')
  }

  /** Closes a group with all its tabs. */
  async function closeGroup(groupId: string): Promise<void> {
    const group = terminals.groups.find((g) => g.id === groupId)
    if (!group) return
    if (group.tabs.length === 0) return terminals.removeEmptyGroup(groupId)
    await closeTabs(group.tabs.map((t) => t.id))
  }

  async function stopTerminal(id: string): Promise<void> {
    await attempt(() => terminals.kill(id), 'Prozess konnte nicht beendet werden')
  }

  /** Starts the tab again; a running process ends first, after a question. */
  async function restartTerminal(id: string): Promise<void> {
    const terminal = terminals.terminals.find((t) => t.id === id)
    if (!terminal || terminal.mode === 'browser') return
    const working = terminal.busy || terminal.compacting || terminal.subagents > 0
    if (terminal.status === 'running' && (working || settings.settings.general.confirmCloseRunning)) {
      const session = terminal.mode === 'session'
      const ok = await ui.confirm({
        title: session ? 'Session neu starten?' : 'Terminal neu starten?',
        description: session
          ? `${working ? 'Claude arbeitet gerade, die laufende Antwort bricht ab. ' : ''}„${terminal.title}“ wird beendet und geht danach mit ihrem Verlauf weiter. Was im Eingabefeld steht und nicht gesendet ist, geht verloren.`
          : `„${terminal.title}“ läuft noch. Der Prozess wird beendet und startet neu.`,
        confirmText: 'Neu starten',
        destructive: working,
      })
      if (!ok) return
    }
    await attempt(() => terminals.restartSession(id), 'Neustart fehlgeschlagen')
  }

  return { closeTerminal, closeTab, closeOtherTabs, closeTabs, closeGroup, stopTerminal, restartTerminal }
}
