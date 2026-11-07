/**
 * The page's dialogs (alert, confirm, prompt): caught and answered at once while Claude acts, or
 * blocking the page until Claude answers them with browser_handle_dialog.
 */

export interface PageDialog {
  type: string
  message: string
  defaultPrompt: string
}

/** Resolves with the next dialog that blocks the page. */
export interface DialogSignal {
  promise: Promise<PageDialog>
  resolve: (dialog: PageDialog) => void
}

export function dialogSignal(): DialogSignal {
  let resolve!: (dialog: PageDialog) => void
  const promise = new Promise<PageDialog>((r) => (resolve = r))
  return { promise, resolve }
}

/** A dialog the page opened while Claude acted, answered right away (see `dialogShim`). */
export interface CaughtDialog extends PageDialog {
  at: string
  /** How it was answered: OK, Cancel or the text given to a prompt. */
  answer: string
}

/** How Claude wants the next dialog answered (browser_handle_dialog before the action). */
export interface DialogAnswer {
  accept: boolean
  promptText: string | null
}

/** The page calls it with the dialogs it caught. */
export const DIALOG_BINDING = '__claudeManagerDialog'
/** How long after an action its dialogs are still caught (a page may open one a moment later). */
export const DIALOG_GRACE_MS = 1500

/**
 * Catches the page's dialogs while Claude acts and answers them at once, in the page's own world.
 * Electron shows a dialog of a page as a message box of its own, which stays open when the
 * DevTools protocol answers the dialog: so the page never gets to open one while Claude acts.
 */
export function dialogShim(answer: DialogAnswer | null): string {
  return `(() => {
  const answer = ${JSON.stringify(answer)}
  const own = window.__claudeManagerDialogs
  if (own) {
    own.on = true
    own.answer = answer
    return
  }
  const native = { alert: window.alert, confirm: window.confirm, prompt: window.prompt }
  const state = { on: true, answer }
  Object.defineProperty(window, '__claudeManagerDialogs', { value: state, configurable: true })
  const text = (value) => (value === undefined || value === null ? '' : String(value))
  const report = (type, message, defaultPrompt, result) => {
    try {
      window.${DIALOG_BINDING}(JSON.stringify({ type, message: text(message), defaultPrompt: text(defaultPrompt), answer: result }))
    } catch {}
  }
  const take = () => {
    const next = state.answer || { accept: true, promptText: null }
    state.answer = null
    return next
  }
  window.alert = function (message) {
    if (!state.on) return native.alert.apply(this, arguments)
    report('alert', message, null, 'OK')
  }
  window.confirm = function (message) {
    if (!state.on) return native.confirm.apply(this, arguments)
    const next = take()
    report('confirm', message, null, next.accept ? 'OK' : 'Cancel')
    return next.accept
  }
  window.prompt = function (message, defaultPrompt) {
    if (!state.on) return native.prompt.apply(this, arguments)
    const next = take()
    const value = next.accept ? (next.promptText ?? text(defaultPrompt)) : null
    report('prompt', message, defaultPrompt, value === null ? 'Cancel' : JSON.stringify(value))
    return value
  }
})()`
}

export const DIALOG_SHIM_OFF = 'window.__claudeManagerDialogs && (window.__claudeManagerDialogs.on = false)'

/** A dialog the shim answered, from what it passed to DIALOG_BINDING; null for anything else. */
export function caughtDialog(payload: unknown): CaughtDialog | null {
  try {
    const raw = JSON.parse(String(payload)) as Record<string, unknown>
    return {
      at: new Date().toISOString(),
      type: String(raw.type),
      message: String(raw.message ?? '').slice(0, 2000),
      defaultPrompt: String(raw.defaultPrompt ?? '').slice(0, 2000),
      answer: String(raw.answer ?? '').slice(0, 2000),
    }
  } catch {
    return null
  }
}

/** A dialog that blocks the page, for Claude. */
export function describeDialog(dialog: PageDialog): string {
  const prompt = dialog.type === 'prompt' ? ` (default answer ${JSON.stringify(dialog.defaultPrompt)})` : ''
  const article = /^[aeiou]/i.test(dialog.type) ? 'an' : 'a'
  return `The page shows ${article} ${dialog.type} dialog: ${JSON.stringify(dialog.message)}${prompt}. It blocks the page until it is answered.`
}
