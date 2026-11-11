type DataHandler = (data: string, offset: number) => void
type ExitHandler = (exitCode: number) => void
type PasteHandler = (text: string) => void

const dataHandlers = new Map<string, Set<DataHandler>>()
const exitHandlers = new Map<string, Set<ExitHandler>>()
/** The view of each terminal, which pastes into it. */
const pasteHandlers = new Map<string, PasteHandler>()
/** The view of each terminal or browser, which gives it the keyboard. */
const focusHandlers = new Map<string, () => void>()
let wired = false

/** One IPC subscription for all terminals; views register per terminal id. */
function wire(): void {
  if (wired) return
  wired = true
  window.api.terminals.onData((id, data, offset) => {
    dataHandlers.get(id)?.forEach((handler) => handler(data, offset))
  })
  window.api.terminals.onExit((id, exitCode) => {
    exitHandlers.get(id)?.forEach((handler) => handler(exitCode))
  })
}

function add<T>(map: Map<string, Set<T>>, id: string, handler: T): () => void {
  wire()
  let set = map.get(id)
  if (!set) {
    set = new Set()
    map.set(id, set)
  }
  set.add(handler)
  return () => {
    set.delete(handler)
    if (set.size === 0) map.delete(id)
  }
}

export const terminalBus = {
  onData: (id: string, handler: DataHandler) => add(dataHandlers, id, handler),
  onExit: (id: string, handler: ExitHandler) => add(exitHandlers, id, handler),
  /** The view of a terminal takes text to paste, e.g. from the file tree. */
  onPaste(id: string, handler: PasteHandler): () => void {
    pasteHandlers.set(id, handler)
    return () => {
      if (pasteHandlers.get(id) === handler) pasteHandlers.delete(id)
    }
  },
  /** Pastes into a terminal like Ctrl+V and gives it the keyboard; false without a view of it. */
  paste(id: string, text: string): boolean {
    const handler = pasteHandlers.get(id)
    handler?.(text)
    return !!handler
  },
  /** The view of a terminal or browser gives it the keyboard when asked (see `focus`). */
  onFocus(id: string, handler: () => void): () => void {
    focusHandlers.set(id, handler)
    return () => {
      if (focusHandlers.get(id) === handler) focusHandlers.delete(id)
    }
  },
  /**
   * Gives the view the keyboard, also when its terminal is the active one already: a click on its tab
   * took the keyboard to the tab, and nothing else changes that would give it back.
   */
  focus(id: string): void {
    focusHandlers.get(id)?.()
  },
}
