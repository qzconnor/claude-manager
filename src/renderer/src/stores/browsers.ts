import { defineStore } from 'pinia'
import { computed, reactive, ref, shallowReactive } from 'vue'
import type {
  BrowserActivity,
  BrowserControlState,
  BrowserCredentials,
  BrowserDownload,
  BrowserDownloadAction,
  BrowserHighlight,
  BrowserLoginRequest,
  ClaudeInChromeStatus,
} from '@shared/types'

/** What a browser pane shows of its page, for its tab. */
export interface BrowserViewState {
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** The page's icon as a data URL; null while it has none (the tab shows a globe). */
  favicon: string | null
}

/** A browser pane as the tab menu and the shortcuts can drive it. */
export interface BrowserView {
  state: BrowserViewState
  back(): void
  forward(): void
  reload(): void
  /** Puts the keyboard into the address bar, with the address selected. */
  focusAddress(): void
  /** Opens the search in the page, or puts the keyboard back into it. */
  find(): void
  /** The next (or previous) match of the search; opens it when it is closed. */
  findAgain(forward: boolean): void
  /** Gives the page the keyboard, for Claude's keys. */
  focusPage(): void
  /** The user clicked into the page. */
  userClicked(): void
}

/** Where Claude acts right now; `seq` tells a repeat of the same place from the last one. */
export interface ShownHighlight extends BrowserHighlight {
  seq: number
}

/** Lines of a browser's log the window keeps; main keeps as many. */
const LOG_LIMIT = 300
/** Claude Code's global configs are read again at most this often (they can be a few MB). */
const CHROME_STATUS_MS = 10_000

/**
 * The browser panes of the window, by the id of their tab (see BrowserPane.vue), and what Claude
 * sessions do in them (main's BrowserControl): who drives which, its log and where it acts.
 */
export const useBrowsersStore = defineStore('browsers', () => {
  const views = shallowReactive(new Map<string, BrowserView>())
  const controls = reactive(new Map<string, BrowserControlState>())
  const logs = reactive(new Map<string, BrowserActivity[]>())
  const highlights = reactive(new Map<string, ShownHighlight>())
  let highlightCount = 0

  /** A browser Claude acted in a moment ago: it is drawn even in a hidden tab, so it can go on. */
  const anyActive = computed(() => [...controls.values()].some((c) => c.active))

  window.api.browser.onControl((id, control) => {
    if (control) controls.set(id, control)
    else controls.delete(id)
  })
  window.api.browser.onActivity((id, activity) => {
    const log = logs.get(id)
    if (!log) {
      logs.set(id, [activity])
      return
    }
    const index = log.findIndex((a) => a.id === activity.id)
    if (index >= 0) log[index] = activity
    else {
      log.push(activity)
      if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
    }
  })
  window.api.browser.onHighlight((id, highlight) => highlights.set(id, { ...highlight, seq: ++highlightCount }))

  /** The browser's downloads, all tabs together, oldest first. */
  const downloads = ref<BrowserDownload[]>([])
  window.api.browser.onDownloads((list) => (downloads.value = list))
  void window.api.browser.downloads().then((list) => (downloads.value = list))

  /** Pages that wait for a user name and password, by the request; each pane shows those of its page. */
  const logins = reactive(new Map<string, BrowserLoginRequest>())
  window.api.browser.onLogin((request) => logins.set(request.id, request))
  window.api.browser.onLoginDone((id) => logins.delete(id))
  window.api.browser.onFocus((id) => views.get(id)?.focusPage())
  window.api.browser.onUserClick((id) => views.get(id)?.userClicked())
  void window.api.browser.controls().then((all) => {
    for (const [id, control] of Object.entries(all)) if (!controls.has(id)) controls.set(id, control)
  })

  /** Where Claude in Chrome starts with a session; `/chrome` in a session can change it any time. */
  const chromeStatus = ref<ClaudeInChromeStatus | null>(null)
  let chromeStatusAt = 0
  function refreshChromeStatus() {
    if (Date.now() - chromeStatusAt < CHROME_STATUS_MS) return
    chromeStatusAt = Date.now()
    void window.api.browser
      .claudeInChrome()
      .then((status) => (chromeStatus.value = status))
      .catch(() => undefined)
  }
  refreshChromeStatus()
  window.addEventListener('focus', refreshChromeStatus)

  /** Main's log of a browser, for a pane that shows it the first time. */
  async function loadLog(id: string) {
    const log = await window.api.browser.log(id)
    // Lines that arrived meanwhile are in main's log too.
    logs.set(id, log)
  }

  async function clearLog(id: string) {
    await window.api.browser.clearLog(id)
    logs.set(id, [])
  }

  return {
    views,
    controls,
    logs,
    highlights,
    anyActive,
    chromeStatus,
    refreshChromeStatus,
    get: (id: string | null | undefined) => (id ? views.get(id) : undefined),
    register: (id: string, view: BrowserView) => void views.set(id, view),
    unregister: (id: string) => {
      views.delete(id)
      controls.delete(id)
      logs.delete(id)
      highlights.delete(id)
    },
    loadLog,
    clearLog,
    takeOver: (id: string, takenOver: boolean) => window.api.browser.takeOver(id, takenOver),
    downloads,
    downloadAction: (id: string, action: BrowserDownloadAction) => window.api.browser.downloadAction(id, action),
    clearDownloads: () => window.api.browser.clearDownloads(),
    logins,
    /** The first question for a login of a page (by the id of its contents). */
    loginFor: (contentsId: number | null) => (contentsId === null ? null : ([...logins.values()].find((l) => l.contentsId === contentsId) ?? null)),
    answerLogin: (id: string, credentials: BrowserCredentials | null) => {
      logins.delete(id)
      return window.api.browser.answerLogin(id, credentials)
    },
    resetViewport: (id: string) => window.api.browser.resetViewport(id),
  }
})
