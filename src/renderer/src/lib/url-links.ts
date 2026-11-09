import type { IBuffer, IBufferCell, IBufferLine, IDisposable, ILink, ILinkProvider, Terminal } from '@xterm/xterm'

/** A URL as xterm's web links addon finds it: up to a space, quote or bracket, without punctuation at its end. */
const URL_RE = /https?:\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/gi
/** A URL that runs to the end of the text: cut there, it may go on in the next row. */
const CUT_URL_RE = /https?:\/\/[^\s"'!*(){}|\\^<>`]*$/i
/** What the rest of a cut URL starts with; not `…` or the frame of a box. */
const URL_GOES_ON_RE = /^[\p{L}\p{N}\-._~:/?#[\]@$&+,;=%]/u
/** In front of the text of a row: indentation, Claude Code's `⎿` before the output of a tool, `▎` before a quote. */
const GUTTER_RE = /[\s⎸-⎿─-▟]/u
/**
 * How many columns before the right edge Claude Code cuts a word that doesn't fit into a row: its
 * answers at the edge, the prompt one column before it, the output of tools five before it. It
 * writes the rest into the next row, behind the indentation, so xterm sees two rows, not one
 * wrapped row.
 */
const CUT_MARGINS = [0, 1, 5]
/** How many rows up and down from the row under the mouse a URL is looked for. */
const MAX_ROWS = 40

/** The text of a row and where each of its characters is. */
interface Row {
  text: string
  /** The column of each character (UTF-16 unit) of `text`. */
  columns: number[]
  /** How many columns each character takes: 2 for wide ones. */
  widths: number[]
  /** The column of the last character that isn't a space; -1 in an empty row. */
  last: number
}

function readRow(line: IBufferLine): Row {
  let text = ''
  const columns: number[] = []
  const widths: number[] = []
  let last = -1
  let cell: IBufferCell | undefined
  for (let x = 0; x < line.length; x++) {
    cell = line.getCell(x, cell)
    if (!cell) break
    const width = cell.getWidth()
    // The second half of a wide character.
    if (width === 0) continue
    const chars = cell.getChars() || ' '
    for (let i = 0; i < chars.length; i++) {
      columns.push(x)
      widths.push(width)
    }
    text += chars
    if (chars.trim()) last = x + width - 1
  }
  return { text, columns, widths, last }
}

/** Text across rows, with the row and column of each character. */
interface Run {
  text: string
  rows: number[]
  columns: number[]
  widths: number[]
}

function append(run: Run, row: Row, y: number, from = 0): void {
  run.text += row.text.slice(from)
  for (let i = from; i < row.text.length; i++) {
    run.rows.push(y)
    run.columns.push(row.columns[i]!)
    run.widths.push(row.widths[i]!)
  }
}

function trimEnd(run: Run): void {
  const length = run.text.trimEnd().length
  run.text = run.text.slice(0, length)
  run.rows.length = run.columns.length = run.widths.length = length
}

/** Where the text of a row starts, behind its gutter. */
function textStart(row: Row): number {
  let i = 0
  while (i < row.text.length && GUTTER_RE.test(row.text[i]!)) i++
  return i
}

const cutAtEdge = (row: Row, cols: number) => row.last >= 0 && CUT_MARGINS.includes(cols - 1 - row.last)

/**
 * Where in `next` the URL at the end of `run` goes on, which Claude Code cut at the end of `row`;
 * -1 when it doesn't. `edge` is the column the rows before were cut at, -1 at the first cut.
 */
function continuation(run: Run, row: Row, next: Row, cols: number, edge: number): number {
  if (edge >= 0 ? row.last !== edge : !cutAtEdge(row, cols)) return -1
  const before = run.text.trimEnd()
  if (!CUT_URL_RE.test(before)) return -1
  const start = textStart(next)
  const rest = next.text.slice(start)
  if (!URL_GOES_ON_RE.test(rest)) return -1
  if (edge < 0) {
    // Claude Code only cuts a word that is longer than the row; a shorter one goes into the next
    // row as a whole. Would the URL and what follows have fit, the URL ended and a word follows.
    const word = before.match(/\S+$/)![0].length + rest.match(/^\S+/)![0].length
    if (word <= row.last - next.columns[start]! + 1) return -1
  }
  return start
}

/** The part of a URL in one row: columns from 0, `end` included. */
export interface UrlPart {
  y: number
  start: number
  end: number
}

export interface FoundUrl {
  url: string
  parts: UrlPart[]
}

/** Whether `text` is a URL whose host is written out in full, like xterm's web links addon checks. */
function isUrl(text: string): boolean {
  try {
    const url = new URL(text)
    const user = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : ''
    return text.toLowerCase().startsWith(`${url.protocol}//${user}${url.host}`.toLowerCase())
  } catch {
    return false
  }
}

function urlsIn(run: Run, y: number): FoundUrl[] {
  const found: FoundUrl[] = []
  for (const match of run.text.matchAll(URL_RE)) {
    const url = match[0]
    if (!isUrl(url)) continue
    const parts: UrlPart[] = []
    for (let i = match.index; i < match.index + url.length; i++) {
      const row = run.rows[i]!
      const end = run.columns[i]! + run.widths[i]! - 1
      const part = parts.at(-1)
      if (part?.y === row) part.end = end
      else parts.push({ y: row, start: run.columns[i]!, end })
    }
    if (parts.some((part) => part.y === y)) found.push({ url, parts })
  }
  return found
}

/**
 * The URLs with a part in row `y` (from 0) of the buffer. A URL goes on in the next row when xterm
 * wrapped the row, and when Claude Code cut it at the end of the row and wrote the rest into the
 * next one.
 */
export function findUrls(buffer: IBuffer, cols: number, y: number): FoundUrl[] {
  const cache = new Map<number, Row | null>()
  const read = (i: number): Row | null => {
    if (!cache.has(i)) {
      const line = buffer.getLine(i)
      cache.set(i, line ? readRow(line) : null)
    }
    return cache.get(i)!
  }
  if (!read(y)) return []

  // Up to the row the text around `y` starts in.
  let top = y
  while (top > 0 && y - top < MAX_ROWS) {
    if (!buffer.getLine(top)?.isWrapped) {
      const above = read(top - 1)
      const row = read(top)!
      const end = above?.text.trimEnd().at(-1)
      if (!above || !cutAtEdge(above, cols) || !end || !/[^\s"'!*(){}|\\^<>`]/.test(end)) break
      if (!URL_GOES_ON_RE.test(row.text.slice(textStart(row)))) break
    }
    top--
  }

  const found: FoundUrl[] = []
  for (let r = top; r <= y; r++) {
    const run: Run = { text: '', rows: [], columns: [], widths: [] }
    append(run, read(r)!, r)
    let edge = -1
    while (r - y < MAX_ROWS) {
      const line = buffer.getLine(r + 1)
      const next = read(r + 1)
      if (!line || !next) break
      if (line.isWrapped) {
        append(run, next, r + 1)
      } else {
        const row = read(r)!
        const start = continuation(run, row, next, cols, edge)
        if (start < 0) break
        edge = row.last
        trimEnd(run)
        append(run, next, r + 1, start)
      }
      r++
    }
    if (r >= y) found.push(...urlsIn(run, y))
  }
  return found
}

export interface UrlLinkOptions {
  open(url: string): void
}

/**
 * Turns URLs into links, also those Claude Code cuts at the end of a row: a click opens the whole
 * URL, and hovering underlines all of its rows (without the indentation in between).
 */
export function urlLinks(term: Terminal, options: UrlLinkOptions): ILinkProvider {
  let underline: IDisposable[] = []
  const clear = () => {
    for (const disposable of underline) disposable.dispose()
    underline = []
  }
  const show = (parts: UrlPart[]) => {
    clear()
    const buffer = term.buffer.active
    const cursor = buffer.baseY + buffer.cursorY
    for (const part of parts) {
      const marker = term.registerMarker(part.y - cursor)
      underline.push(marker)
      const decoration = term.registerDecoration({ marker, x: part.start, width: part.end - part.start + 1, layer: 'top' })
      if (!decoration) continue
      underline.push(decoration)
      decoration.onRender((element) => {
        element.style.pointerEvents = 'none'
        element.style.boxSizing = 'border-box'
        element.style.borderBottom = `1px solid ${term.options.theme?.foreground ?? 'currentColor'}`
        // Where xterm draws the underline of a link: a device pixel above the bottom of the cell.
        element.style.transform = `translateY(${-1 / window.devicePixelRatio}px)`
      })
    }
  }
  return {
    provideLinks(y, callback) {
      const buffer = term.buffer.active
      // xterm draws no decorations over the alternate buffer: there it underlines the row under the mouse.
      const alternate = buffer.type === 'alternate'
      const links = findUrls(buffer, term.cols, y - 1).flatMap(({ url, parts }) =>
        parts
          .filter((part) => part.y === y - 1)
          .map(
            (part): ILink => ({
              range: { start: { x: part.start + 1, y }, end: { x: part.end + 1, y } },
              text: url,
              decorations: { pointerCursor: true, underline: alternate },
              activate: (event) => {
                event.preventDefault()
                options.open(url)
              },
              hover: () => {
                if (!alternate) show(parts)
              },
              leave: clear,
            }),
          ),
      )
      callback(links.length ? links : undefined)
    },
  }
}
