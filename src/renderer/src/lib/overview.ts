import type { TerminalInfo } from '@shared/types'

/**
 * Where a tab stands for the overview: Claude waits for the user (a permission, a question, a plan,
 * or a limit), works, is ready for the next prompt, or the process ended.
 */
export type OverviewState = 'waiting' | 'working' | 'ready' | 'ended'

export const OVERVIEW_STATES: readonly OverviewState[] = ['waiting', 'working', 'ready', 'ended']

/** Tabs the overview shows: everything with a process, not browsers. */
export function inOverview(terminal: TerminalInfo): boolean {
  return terminal.mode !== 'browser'
}

export function overviewState(terminal: TerminalInfo): OverviewState {
  if (terminal.status === 'exited') return 'ended'
  if (terminal.limit || terminal.turn?.kind === 'input') return 'waiting'
  if (terminal.busy) return 'working'
  return 'ready'
}

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0)

/**
 * The tabs by state, in the order the overview shows them: the longest waiting first, those that
 * finished last first among the ready ones, the rest in the order of the tabs.
 */
export function overviewGroups(terminals: readonly TerminalInfo[]): Record<OverviewState, TerminalInfo[]> {
  const groups: Record<OverviewState, TerminalInfo[]> = { waiting: [], working: [], ready: [], ended: [] }
  for (const terminal of terminals) if (inOverview(terminal)) groups[overviewState(terminal)].push(terminal)
  // A limit without a turn's end (the app read it from the transcript) waits since the tab started.
  groups.waiting.sort((a, b) => time(a.turn?.at ?? a.createdAt) - time(b.turn?.at ?? b.createdAt))
  groups.ready.sort((a, b) => time(b.turn?.at) - time(a.turn?.at))
  return groups
}

/**
 * The waiting tab to go to from `current`: the one after it, or the longest waiting one when
 * `current` doesn't wait. Null when none waits.
 */
export function nextWaiting(terminals: readonly TerminalInfo[], current: string | null): string | null {
  const waiting = overviewGroups(terminals).waiting
  if (waiting.length === 0) return null
  const index = waiting.findIndex((t) => t.id === current)
  return waiting[(index + 1) % waiting.length]!.id
}
