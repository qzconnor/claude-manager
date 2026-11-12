import type { IBuffer, IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm'

/** Claude Code's pointer before the user's own messages (`figures.pointer`). */
const POINTER = '❯'
/** After the pointer a space; in the input box a no-break space. */
const AFTER_POINTER = new Set([' ', ' ', ''])

/** What `promptRows` reads of a buffer. */
export type PromptBuffer = Pick<IBuffer, 'length' | 'getLine' | 'getNullCell'>

/**
 * The rows of the buffer where the user's own messages to Claude Code start: Claude Code shows them as
 * `❯ text` on a bar of their own background (`userMessageBackground`). Its input box starts with `❯ `
 * too, but without a background; the rows a long message wraps into don't count.
 */
export function promptRows(buffer: PromptBuffer): number[] {
  const rows: number[] = []
  const cell = buffer.getNullCell()
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (!line || line.isWrapped || line.getCell(0, cell)?.getChars() !== POINTER || cell.isBgDefault()) continue
    if (AFTER_POINTER.has(line.getCell(1, cell)?.getChars() ?? '')) rows.push(y)
  }
  return rows
}

/** The row a jump to the prompt in `row` puts at the top: the one above it, Claude Code's space before a message. */
const topFor = (row: number) => Math.max(0, row - 1)

/**
 * Where to scroll for the prompt before (`-1`) or after (`1`) the view whose top row is `top`: the row
 * to put at the top. Null when there is none that way.
 */
export function turnTarget(rows: readonly number[], top: number, direction: -1 | 1): number | null {
  if (direction < 0) {
    for (let i = rows.length - 1; i >= 0; i--) if (topFor(rows[i]!) < top) return topFor(rows[i]!)
    return null
  }
  for (const row of rows) if (topFor(row) > top) return topFor(row)
  return null
}

/** How long output may pour in before the prompts are looked for again (ms). */
const SCAN_MS = 500
/** The overview ruler: as wide as xterm's scrollbar, which then keeps its width. */
export const RULER_WIDTH = 14

export interface TurnMarks extends IDisposable {
  /** Scrolls to the prompt before (`-1`) or after (`1`) the one at the top; after the last one to the end. False without prompts. */
  jump(direction: -1 | 1): boolean
  /** Looks for the prompts again now, e.g. once the terminal is on screen. */
  refresh(): void
}

/**
 * Marks the user's prompts in Claude Code's output beside the scrollbar (xterm's overview ruler, set
 * `overviewRuler.width` to `RULER_WIDTH`) and jumps between them. The prompts are read off the buffer,
 * so they stay right when Claude Code draws its output anew (a resize, `/clear`). Looked for while
 * output comes, at most every `SCAN_MS`, and only while `shown`.
 */
export function turnMarks(term: Terminal, options: { color: () => string; shown: () => boolean }): TurnMarks {
  const marks = new Map<IMarker, IDecoration>()
  let color = ''
  let timer = 0
  let disposed = false

  function clear(): void {
    for (const [marker, decoration] of marks) {
      decoration.dispose()
      marker.dispose()
    }
    marks.clear()
  }

  function refresh(): void {
    clearTimeout(timer)
    timer = 0
    if (disposed) return
    const buffer = term.buffer.active
    // Claude Code shows its conversation in the normal buffer; a full-screen program has no prompts.
    if (buffer.type !== 'normal') return
    const now = options.color()
    if (now !== color) {
      clear()
      color = now
    }
    const rows = new Set(promptRows(buffer))
    for (const [marker, decoration] of marks) {
      if (rows.delete(marker.line)) continue
      decoration.dispose()
      marker.dispose()
      marks.delete(marker)
    }
    const cursor = buffer.baseY + buffer.cursorY
    for (const row of rows) {
      const marker = term.registerMarker(row - cursor)
      if (!marker) continue
      const decoration = term.registerDecoration({ marker, overviewRulerOptions: { color, position: 'full' } })
      if (!decoration) {
        marker.dispose()
        continue
      }
      marks.set(marker, decoration)
      // Gone with its row (the scrollback is full, the screen was cleared).
      marker.onDispose(() => {
        decoration.dispose()
        marks.delete(marker)
      })
    }
  }

  const written = term.onWriteParsed(() => {
    if (!timer && options.shown()) timer = window.setTimeout(refresh, SCAN_MS)
  })

  return {
    jump(direction) {
      const buffer = term.buffer.active
      if (buffer.type !== 'normal') return false
      const rows = promptRows(buffer)
      if (rows.length === 0) return false
      const target = turnTarget(rows, buffer.viewportY, direction)
      if (target !== null) term.scrollToLine(target)
      else if (direction > 0) term.scrollToBottom()
      return true
    },
    refresh,
    dispose() {
      disposed = true
      clearTimeout(timer)
      written.dispose()
      clear()
    },
  }
}
