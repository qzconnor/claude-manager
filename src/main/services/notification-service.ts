import { Notification, type BrowserWindow } from 'electron'
import type { AttentionKind, NotificationSettings, TerminalInfo } from '@shared/types'
import { limitLabel } from '@shared/utils'
import { resourceIcon } from '../window/tray'
import type { SettingsService } from './settings-service'
import type { TerminalService, TurnEnd } from './terminal-service'

/** Longest text of an answer, command or question in a notification. */
const MAX_DETAIL_CHARS = 180

/**
 * Points to tabs in which Claude Code is done, waits for the user or hit a limit (settings
 * `notifications`): a system notification, the flashing taskbar button and the dot on the tab.
 */
export class NotificationService {
  /** The tab the window shows: the selected one while the terminals page is open, otherwise none. */
  private viewing: string | null = null
  /**
   * The latest notification of each tab. Kept so it can be taken back once the tab was seen, and
   * so a click on it still arrives (Electron loses the events of collected notifications).
   */
  private readonly shown = new Map<string, Notification>()
  private test: Notification | null = null

  constructor(
    private readonly terminals: TerminalService,
    private readonly settings: SettingsService,
    private readonly window: () => BrowserWindow | null,
    /** Brings the window to the front and selects the tab. */
    private readonly showTerminal: (id: string) => void,
  ) {}

  init(): void {
    this.terminals.on('turnEnded', (id, turn) => this.turnEnded(id, turn))
    this.terminals.on('changed', (terminals) => {
      // A closed tab takes its notification along.
      for (const id of [...this.shown.keys()]) {
        if (!terminals.some((t) => t.id === id)) this.dismiss(id)
      }
    })
    this.settings.on('changed', (next) => {
      const { enabled, unreadDot } = next.notifications
      if (enabled && unreadDot) return
      for (const terminal of this.terminals.list()) {
        if (terminal.attention) this.terminals.setAttention(terminal.id, null)
      }
    })
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
    let terminal: TerminalInfo
    try {
      terminal = this.terminals.get(id)
    } catch {
      return
    }
    const win = this.window()
    const inBackground = !win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused()
    const shown = this.viewing === id

    // The dot also marks short answers and muted tabs: it doesn't interrupt anybody.
    if (settings.unreadDot && !shown) this.terminals.setAttention(id, turn.kind)

    if (terminal.muted) return
    if (!(inBackground || (settings.when === 'hidden' && !shown))) return
    if (turn.kind === 'done' && turn.busyMs < settings.minBusySeconds * 1000) return
    if (settings.toast) this.notify(terminal, turn, settings)
    // The taskbar button only flashes for a window in the background; it stops once the window is in front.
    if (settings.flashTaskbar && inBackground && win && !win.isDestroyed()) win.flashFrame(true)
  }

  private notify(terminal: TerminalInfo, turn: TurnEnd, settings: NotificationSettings): void {
    if (!Notification.isSupported()) return
    const { title, detail } = describe(terminal, turn, settings.preview)
    const notification = this.create(title, detail ? `${terminal.title}\n${detail}` : terminal.title, settings)
    notification.on('click', () => this.showTerminal(terminal.id))
    // One notification per tab: the newer one replaces the older.
    this.dismiss(terminal.id)
    this.shown.set(terminal.id, notification)
    notification.show()
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
