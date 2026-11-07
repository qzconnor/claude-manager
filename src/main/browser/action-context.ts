import type { NativeImage } from 'electron'
import type { BrowserEmulation, BrowserLoginRequest } from '@shared/types'
import type { PageDriver } from './page-driver'
import type { NetworkEntry } from './network-log'
import type { CaughtDialog, DialogAnswer, PageDialog } from './page-dialogs'

/** What the browser's tools get from BrowserControl while their action runs, and what they read of the page. */

export interface ConsoleEntry {
  at: string
  level: string
  text: string
  source: string
}

export interface FileChooser {
  backendNodeId: number
  multiple: boolean
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Something the page did by itself that Claude should hear of: a popup window, a download. */
export interface PageEvent {
  at: string
  text: string
}

/** A browser tab as browser_tabs lists it. */
export interface BrowserTab {
  index: number
  id: string
  title: string
  url: string
  /** The session's actions go to it. */
  current: boolean
  /** The session opened it (it may close it). */
  openedBySession: boolean
  /** Another Claude session drives it right now. */
  otherSession: string | null
}

/** What a tool can do while its action runs (see `BrowserControl.perform`). */
export interface ActionContext {
  readonly browserId: string
  readonly page: PageDriver
  /** The log line's text, once the target is known (e.g. the name of the clicked button). */
  label(text: string): void
  /** What came out, for the log line. */
  note(text: string): void
  /** A small picture of the page for the log line. */
  image(image: NativeImage): void
  /**
   * Shows the user where Claude acts: the element and the spot Claude's mouse pointer goes to (and
   * clicks, with `pointer.click`), in CSS pixels of the page's viewport. Returns how long the
   * pointer takes to get there (ms): the action should wait for it.
   */
  highlight(label: string, box?: Box | null, pointer?: { x: number; y: number; click?: boolean } | null): number
  /**
   * The page as Claude reads it. `changes`: only what changed since the session's last snapshot of
   * this document (see snapshot-diff.ts), when that is shorter; otherwise the whole outline.
   */
  snapshot(changes: boolean): Promise<string>
  consoleEntries(): ConsoleEntry[]
  networkEntries(): NetworkEntry[]
  /** What the page pretends right now (browser_emulate). */
  emulation(): BrowserEmulation | null
  /** Has the page pretend this from now on (null: nothing); it stays until the session ends or the user resets it. */
  setEmulation(emulation: BrowserEmulation | null): Promise<void>
  /** A dialog that blocks the page until it is answered (one the page opened while Claude didn't act). */
  dialog(): PageDialog | null
  /** Resolves when the page opens such a dialog. */
  untilDialog(): Promise<PageDialog>
  /** The dialogs answered right away since then (ISO time). */
  caughtDialogs(since: string): CaughtDialog[]
  /** Popups and downloads of the page that no result named yet (also those of a moment after an action). */
  pageEvents(): PageEvent[]
  /** The page waits for a user name and password, which the user enters in its pane. */
  login(): BrowserLoginRequest | null
  /** Resolves when the page asks for a login. */
  untilLogin(): Promise<BrowserLoginRequest>
  /** How the next dialog is answered; null: OK, and a prompt's default. */
  setDialogAnswer(answer: DialogAnswer | null): void
  fileChooser(): FileChooser | null
  clearFileChooser(): void
  /** The page's file chooser comes to Claude instead of the user while `work` runs. */
  interceptFileChooser<T>(work: () => Promise<T>): Promise<T>
  /**
   * Gives the page a size of its own (CSS pixels; null: its part of the tab again), as a phone with
   * `mobile`. Resolves once the page has it; true when phone mode changed (the page should load again).
   */
  setViewport(size: ViewportSize | null): Promise<boolean>
}

export interface ViewportSize {
  width: number
  height: number
  mobile: boolean
}

/** One of Claude's actions, as `perform` runs it. */
export interface ActionStep {
  kind: string
  /** The log line, until the action names its target. */
  label: string
  /** The action also works while the page shows a dialog (which blocks the page's scripts). */
  whileDialog?: boolean
}
