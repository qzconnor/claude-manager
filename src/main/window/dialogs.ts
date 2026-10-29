import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { IpcEvent, IpcSend } from '@shared/ipc'
import type { DialogOptions, DialogRequest } from '@shared/types'
import { revealWindow } from './main-window'

interface PendingDialog {
  contents: WebContents
  request: DialogRequest
  /** Delivered to the page (otherwise it waits for the page to listen). */
  sent: boolean
  resolve: (confirmed: boolean) => void
}

/**
 * Message boxes of the main process, rendered by the window itself so they match the app.
 * A native box is only the fallback when the page can't answer (crashed or reloading).
 */
export class WindowDialogs {
  private readonly pending = new Map<string, PendingDialog>()
  private readonly listening = new WeakSet<WebContents>()
  private readonly watched = new WeakSet<WebContents>()

  constructor() {
    ipcMain.on(IpcSend.dialogsReady, (event) => {
      this.watch(event.sender)
      this.listening.add(event.sender)
      for (const entry of this.pending.values()) {
        if (entry.contents === event.sender && !entry.sent) this.deliver(entry)
      }
    })
    ipcMain.on(IpcSend.dialogAnswer, (event, id: unknown, confirmed: unknown) => {
      const entry = typeof id === 'string' ? this.pending.get(id) : undefined
      if (!entry || entry.contents !== event.sender) return
      this.pending.delete(id as string)
      entry.resolve(confirmed === true)
    })
  }

  /** Resolves with true when the user confirmed (or acknowledged an alert). */
  show(win: BrowserWindow, options: DialogOptions): Promise<boolean> {
    const contents = win.webContents
    const ready = this.listening.has(contents)
    // A decision is needed now, so a confirmation can't wait for a page that isn't listening.
    // An alert waits for the page that is still starting.
    if (!ready && (options.kind !== 'alert' || contents.isCrashed())) return this.showNative(win, options)
    this.watch(contents)
    return new Promise((resolve) => {
      const entry: PendingDialog = { contents, request: { ...options, id: randomUUID() }, sent: false, resolve }
      this.pending.set(entry.request.id, entry)
      if (ready) this.deliver(entry)
    })
  }

  private deliver(entry: PendingDialog): void {
    const win = BrowserWindow.fromWebContents(entry.contents)
    if (win) revealWindow(win)
    entry.sent = true
    entry.contents.send(IpcEvent.dialogRequest, entry.request)
  }

  private watch(contents: WebContents): void {
    if (this.watched.has(contents)) return
    this.watched.add(contents)
    const cancel = (all: boolean) => {
      this.listening.delete(contents)
      for (const [id, entry] of this.pending) {
        if (entry.contents !== contents || (!all && !entry.sent)) continue
        this.pending.delete(id)
        entry.resolve(false)
      }
    }
    // A reloaded page lost the dialogs it showed; ones it never got go to the new page.
    contents.on('did-navigate', () => cancel(false))
    contents.on('render-process-gone', () => cancel(true))
    contents.once('destroyed', () => cancel(true))
  }

  private async showNative(win: BrowserWindow, options: DialogOptions): Promise<boolean> {
    const alert = options.kind === 'alert'
    const { response } = await dialog.showMessageBox(win, {
      type: options.warning ? 'warning' : alert ? 'info' : 'question',
      title: 'Claude Manager',
      message: options.title,
      detail: options.description,
      buttons: alert ? [options.confirmText ?? 'OK'] : [options.confirmText ?? 'OK', options.cancelText ?? 'Abbrechen'],
      defaultId: alert ? 0 : 1,
      cancelId: alert ? 0 : 1,
      noLink: true,
    })
    return response === 0
  }
}
