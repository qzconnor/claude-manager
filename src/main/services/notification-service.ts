import { join } from 'node:path'
import { Notification, type BrowserWindow } from 'electron'
import { SYSTEM_ACCOUNT_ID } from '@shared/defaults'
import type { Account, AccountUsage, AttentionKind, NotificationSettings, TerminalInfo } from '@shared/types'
import { isPlainObject, limitLabel, standardTwin } from '@shared/utils'
import { readJson, writeJsonAtomic } from '../lib/json-file'
import { nearLimits, type NearLimit, type WarnedWindows } from '../lib/near-limit'
import { resourceIcon } from '../window/tray'
import type { AccountService } from './account-service'
import type { AutoSwitch } from './auto-switch'
import type { SettingsService } from './settings-service'
import type { TerminalService, TurnEnd } from './terminal-service'
import type { UsageService } from './usage-service'

/** Longest text of an answer, command or question in a notification. */
const MAX_DETAIL_CHARS = 180

interface WarnedFile {
  version: 1
  warned: WarnedWindows
}

/** Where the app goes when a notification is clicked; both bring the window to the front. */
export interface NotificationTargets {
  /** Selects the terminal's tab. */
  terminal(id: string): void
  /** Shows the usage page. */
  usage(): void
}

/**
 * Points to tabs in which Claude Code is done, waits for the user or hit a limit (settings
 * `notifications`): a system notification, the flashing taskbar button and the dot on the tab.
 * Also warns when an account's limit is nearly used up.
 */
export class NotificationService {
  /** The tab the window shows: the selected one while the terminals page is open, otherwise none. */
  private viewing: string | null = null
  /**
   * The latest notification of each tab. Kept so it can be taken back once the tab was seen, and
   * so a click on it still arrives (Electron loses the events of collected notifications).
   */
  private readonly shown = new Map<string, Notification>()
  /** The latest warning about a limit of each account, kept for the same reasons. */
  private readonly limitWarnings = new Map<string, Notification>()
  private test: Notification | null = null
  private readonly warnedFile: string
  /** Limit windows that were already warned about, kept across restarts. */
  private warned: WarnedWindows = {}
  private autoSwitch: Pick<AutoSwitch, 'tellsLimit'> | null = null

  constructor(
    private readonly terminals: TerminalService,
    private readonly accounts: AccountService,
    private readonly usage: UsageService,
    private readonly settings: SettingsService,
    userDataDir: string,
    private readonly window: () => BrowserWindow | null,
    private readonly open: NotificationTargets,
  ) {
    this.warnedFile = join(userDataDir, 'cache', 'limit-warnings.json')
  }

  async init(): Promise<void> {
    const stored = await readJson<WarnedFile>(this.warnedFile)
    if (stored?.version === 1 && isPlainObject(stored.warned)) {
      for (const [key, resetsAt] of Object.entries(stored.warned)) {
        if (typeof resetsAt === 'string' || resetsAt === null) this.warned[key] = resetsAt
      }
    }
    this.terminals.on('turnEnded', (id, turn) => this.turnEnded(id, turn))
    this.terminals.on('changed', (terminals) => {
      // A closed tab takes its notification along.
      for (const id of [...this.shown.keys()]) {
        if (!terminals.some((t) => t.id === id)) this.dismiss(id)
      }
    })
    this.settings.on('changed', (next, previous) => {
      // Switched on or another threshold: windows that are above it now warn right away.
      if (
        nearLimitWanted(next.notifications) !== nearLimitWanted(previous.notifications) ||
        next.notifications.nearLimitPercent !== previous.notifications.nearLimitPercent
      ) {
        this.checkLimits()
      }
      const { enabled, unreadDot } = next.notifications
      if (enabled && unreadDot) return
      for (const terminal of this.terminals.list()) {
        if (terminal.attention) this.terminals.setAttention(terminal.id, null)
      }
    })
    this.usage.on('changed', () => this.checkLimits())
    this.checkLimits()
  }

  /**
   * Sessions that go on with another account by themselves (setting `claude.autoSwitch`): one
   * notification tells about the limit and the account they continue with, or that the switch failed.
   */
  watchAutoSwitch(autoSwitch: AutoSwitch): void {
    this.autoSwitch = autoSwitch
    autoSwitch.on('switched', (from, to, target) => this.switched(from, to, target))
    autoSwitch.on('failed', (from, target, message) => this.switchFailed(from, target, message))
  }

  /** The window tells which tab it shows (null: another page); that tab is seen. */
  setViewing(id: string | null): void {
    this.viewing = id
    if (id) this.seen(id)
  }

  /** The window came to the front: the notification of the tab it shows is no longer needed. */
  windowFocused(): void {
    if (this.viewing) this.seen(this.viewing)
  }

  /** Shows what a notification looks like with the current settings. */
  showTest(): void {
    if (!Notification.isSupported()) throw new Error('Dieses System zeigt keine Benachrichtigungen an.')
    const settings = this.settings.get().notifications
    this.test?.close()
    this.test = this.create(
      'Claude ist fertig',
      settings.preview ? 'Beispiel-Tab\nSo erscheint hier der Anfang der Antwort.' : 'Beispiel-Tab',
      settings,
    )
    this.test.show()
  }

  private turnEnded(id: string, turn: TurnEnd): void {
    const settings = this.settings.get().notifications
    if (!settings.enabled || !wanted(settings, turn.kind)) return
    // The tab goes on with another account (or that failed): the notification about it tells of the limit.
    if (turn.kind === 'limit' && this.autoSwitch?.tellsLimit(id)) return
    let terminal: TerminalInfo
    try {
      terminal = this.terminals.get(id)
    } catch {
      return
    }
    const shown = this.viewing === id

    // The dot also marks short answers and muted tabs: it doesn't interrupt anybody.
    if (settings.unreadDot && !shown) this.terminals.setAttention(id, turn.kind)

    if (terminal.muted) return
    if (turn.kind === 'done' && turn.busyMs < settings.minBusySeconds * 1000) return
    const { title, detail } = describe(terminal, turn, settings.preview)
    this.alert(terminal, title, detail, shown, settings)
  }

  private switched(from: TerminalInfo, to: TerminalInfo, target: Account): void {
    const settings = this.settings.get().notifications
    if (!settings.enabled || !settings.onLimit || to.muted) return
    const limit = `${limitLabel(from.limit?.type ?? null)} von „${this.accountName(from.authAccountId)}“ erreicht`
    const shown = this.viewing === from.id || this.viewing === to.id
    this.alert(to, `Weiter mit „${target.name}“`, limit, shown, settings)
  }

  private switchFailed(from: TerminalInfo, target: Account, message: string): void {
    const settings = this.settings.get().notifications
    if (!settings.enabled || !settings.onLimit || from.muted) return
    const limit = `${limitLabel(from.limit?.type ?? null)} erreicht`
    this.alert(from, `Wechsel zu „${target.name}“ fehlgeschlagen`, `${limit} · ${message}`, this.viewing === from.id, settings)
  }

  private accountName(id: string): string {
    return this.accounts.list().find((account) => account.id === id)?.name ?? 'dem Account'
  }

  /** Notification and flashing taskbar button, unless the user looks at the tab anyway (setting `when`). */
  private alert(
    terminal: TerminalInfo,
    title: string,
    detail: string | null,
    shown: boolean,
    settings: NotificationSettings,
  ): void {
    const win = this.window()
    const inBackground = !win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused()
    if (!(inBackground || (settings.when === 'hidden' && !shown))) return
    if (settings.toast) this.notify(terminal, title, detail, settings)
    // The taskbar button only flashes for a window in the background; it stops once the window is in front.
    if (settings.flashTaskbar && inBackground && win && !win.isDestroyed()) win.flashFrame(true)
  }

  private notify(terminal: TerminalInfo, title: string, detail: string | null, settings: NotificationSettings): void {
    if (!Notification.isSupported()) return
    const notification = this.create(title, detail ? `${terminal.title}\n${detail}` : terminal.title, settings)
    notification.on('click', () => this.open.terminal(terminal.id))
    // One notification per tab: the newer one replaces the older.
    this.dismiss(terminal.id)
    this.shown.set(terminal.id, notification)
    notification.show()
  }

  /**
   * Warns about limit windows that reached the threshold (setting `nearLimitPercent`), once per
   * account, window and reset. Only while the warning is on: windows that reach it meanwhile warn
   * once it is switched on again, unless they reset in between.
   */
  private checkLimits(): void {
    const settings = this.settings.get().notifications
    if (!nearLimitWanted(settings)) return
    const accounts = this.accounts.list()
    // The standard account shares its limits with its twin and isn't on the usage page then.
    const twin = standardTwin(accounts)
    const before = JSON.stringify(this.warned)
    for (const key of Object.keys(this.warned)) {
      if (!accounts.some((account) => key.startsWith(`${account.id}\n`))) delete this.warned[key]
    }
    for (const id of [...this.limitWarnings.keys()]) {
      if (!accounts.some((account) => account.id === id)) this.dismissLimitWarning(id)
    }
    const usage = new Map(this.usage.getAll().map((u): [string, AccountUsage] => [u.accountId, u]))
    for (const account of accounts) {
      const accountUsage = usage.get(account.id)
      if (!accountUsage || (twin && account.id === SYSTEM_ACCOUNT_ID)) continue
      const reached = nearLimits(accountUsage, settings.nearLimitPercent, this.warned, Date.now())
      if (reached.length > 0) this.warnLimit(account, reached, settings)
    }
    if (JSON.stringify(this.warned) !== before) {
      void writeJsonAtomic(this.warnedFile, { version: 1, warned: this.warned } satisfies WarnedFile).catch(() => undefined)
    }
  }

  /** One notification per account; a click shows the usage page. */
  private warnLimit(account: Account, reached: NearLimit[], settings: NotificationSettings): void {
    if (!Notification.isSupported()) return
    const lines = reached.map(({ window, percent }) => {
      const reset = window.resetsAt ? formatReset(window.resetsAt) : ''
      return `${window.label}: ${percent} %${reset ? `, Reset ${reset}` : ''}`
    })
    const notification = this.create(
      reached[0].percent >= 100 ? 'Limit erreicht' : 'Limit fast erreicht',
      [account.name, ...lines].join('\n'),
      settings,
    )
    notification.on('click', () => this.open.usage())
    this.dismissLimitWarning(account.id)
    this.limitWarnings.set(account.id, notification)
    notification.show()
  }

  private dismissLimitWarning(accountId: string): void {
    const notification = this.limitWarnings.get(accountId)
    if (!notification) return
    this.limitWarnings.delete(accountId)
    notification.close()
  }

  private create(title: string, body: string, settings: NotificationSettings): Notification {
    return new Notification({
      title,
      body,
      silent: !settings.sound,
      // Windows shows the icon of the app's shortcut, Linux needs it given.
      ...(process.platform === 'linux' ? { icon: resourceIcon('icon.png') } : {}),
    })
  }

  private seen(id: string): void {
    this.terminals.setAttention(id, null)
    this.dismiss(id)
  }

  /** Takes the tab's notification back, also out of the notification center. */
  private dismiss(id: string): void {
    const notification = this.shown.get(id)
    if (!notification) return
    this.shown.delete(id)
    notification.close()
  }
}

/** Warnings about limits only come as system notifications. */
function nearLimitWanted(settings: NotificationSettings): boolean {
  return settings.enabled && settings.onNearLimit && settings.toast
}

function wanted(settings: NotificationSettings, kind: AttentionKind): boolean {
  if (kind === 'done') return settings.onDone
  if (kind === 'input') return settings.onInput
  return settings.onLimit
}

/** Heading and second line of the notification; the tab's title comes in between. */
function describe(terminal: TerminalInfo, turn: TurnEnd, preview: boolean): { title: string; detail: string | null } {
  if (turn.kind === 'limit') {
    const resetsAt = terminal.limit?.resetsAt
    return {
      title: `${limitLabel(terminal.limit?.type ?? null)} erreicht`,
      detail: resetsAt ? `Reset ${formatReset(resetsAt)}` : preview ? shorten(turn.detail) : null,
    }
  }
  if (turn.kind === 'input') {
    const detail = preview ? shorten(turn.detail) : null
    if (turn.tool === 'AskUserQuestion') return { title: 'Claude hat eine Frage', detail }
    if (turn.tool === 'ExitPlanMode') return { title: 'Claude wartet auf die Freigabe des Plans', detail }
    const tool = turn.tool ?? 'ein Tool'
    return { title: 'Claude braucht deine Erlaubnis', detail: detail ? `${tool}: ${detail}` : preview ? tool : null }
  }
  return { title: 'Claude ist fertig', detail: preview ? shorten(plainText(turn.detail)) : null }
}

/** Markdown of an answer as plain text on one line; code blocks are left out. */
export function plainText(markdown: string | null): string | null {
  if (!markdown) return null
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/^[ \t]{0,3}(#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]?)/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return text || null
}

function shorten(text: string | null): string | null {
  const single = text?.replace(/\s+/g, ' ').trim()
  if (!single) return null
  return single.length > MAX_DETAIL_CHARS ? `${single.slice(0, MAX_DETAIL_CHARS - 1)}…` : single
}

/** "um 19:40", on another day "Fr. 19:40". */
function formatReset(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const time = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === new Date().toDateString()) return `um ${time}`
  return `${date.toLocaleDateString('de-DE', { weekday: 'short' })} ${time}`
}
