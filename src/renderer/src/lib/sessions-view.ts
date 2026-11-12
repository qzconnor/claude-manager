import type { SessionSort } from './session-tree'

/** Sort and filters of the sessions page, kept for the next time it opens, also after a restart. */
export interface SessionsView {
  sort: SessionSort
  /** An account id, or `all`. */
  account: string
  /** A value of the age filter, or `all`. */
  age: string
  /** A value of the size filter, or `all`. */
  size: string
  /** With several accounts: the standard account's sessions show too. */
  showStandard: boolean
  /** A tag after a `#` (tags never start with one), or `all`. */
  tag: string
}

export const SESSIONS_VIEW_KEY = 'claude-manager.sessions-view'

export const DEFAULT_SESSIONS_VIEW: SessionsView = {
  sort: 'recent',
  account: 'all',
  age: 'all',
  size: 'all',
  showStandard: false,
  tag: 'all',
}

/** The values the page knows; anything else (an older version, a filter that went) counts as not set. */
export interface SessionsViewChoices {
  sorts: readonly string[]
  ages: readonly string[]
  sizes: readonly string[]
}

/** What was kept (localStorage); unknown or broken parts are left at their defaults. */
export function parseSessionsView(raw: string | null, choices: SessionsViewChoices): SessionsView {
  let value: unknown
  try {
    value = raw ? JSON.parse(raw) : null
  } catch {
    value = null
  }
  const view = { ...DEFAULT_SESSIONS_VIEW }
  if (!value || typeof value !== 'object') return view
  const kept = value as Record<string, unknown>
  const pick = (key: 'age' | 'size', allowed: readonly string[]) =>
    typeof kept[key] === 'string' && allowed.includes(kept[key]) ? kept[key] : 'all'
  if (typeof kept.sort === 'string' && choices.sorts.includes(kept.sort)) view.sort = kept.sort as SessionSort
  if (typeof kept.account === 'string' && kept.account) view.account = kept.account
  view.age = pick('age', choices.ages)
  view.size = pick('size', choices.sizes)
  view.showStandard = kept.showStandard === true
  if (typeof kept.tag === 'string' && kept.tag.length > 1 && kept.tag.startsWith('#')) view.tag = kept.tag
  return view
}

export function readSessionsView(choices: SessionsViewChoices): SessionsView {
  try {
    return parseSessionsView(localStorage.getItem(SESSIONS_VIEW_KEY), choices)
  } catch {
    // No storage (blocked or full): the page starts as always.
    return { ...DEFAULT_SESSIONS_VIEW }
  }
}

export function saveSessionsView(view: SessionsView): void {
  try {
    localStorage.setItem(SESSIONS_VIEW_KEY, JSON.stringify(view))
  } catch {
    // Not kept this time; the page works without.
  }
}
