import type { IDisposable, Terminal } from '@xterm/xterm'

/**
 * xterm's DOM renderer takes the block characters (▀ ▄ █ ▌ ▐ ▖ … ▟, U+2580–U+259F) from the font.
 * Their glyphs reach neither the next cell nor the bottom of a row made taller by the line height, so
 * gaps show between them, e.g. in Claude Code's crab. WebGL draws them itself, filling the cell; here
 * each one gets a box of its own, and its `::before` and `::after` fill the parts of the cell in the
 * text color. Their edges are the box's, so the browser puts them on whole pixels like the box and
 * neighbouring cells meet without a seam (background layers sized in percent get soft edges there).
 * The character stays in the box, see-through: the box keeps its width of a cell (the glyph plus
 * xterm's letter spacing), and the text of the row stays the same.
 */

/** A part of the cell: left, top, width and height as fractions of it. */
type Rect = readonly [x: number, y: number, w: number, h: number]

interface Shape {
  rects: readonly Rect[]
  /** The shades ░ ▒ ▓ fill the cell in part of the color. */
  alpha?: number
}

const FULL: Rect = [0, 0, 1, 1]
const TOP: Rect = [0, 0, 1, 0.5]
const BOTTOM: Rect = [0, 0.5, 1, 0.5]
const LEFT: Rect = [0, 0, 0.5, 1]
const RIGHT: Rect = [0.5, 0, 0.5, 1]
const UPPER_LEFT: Rect = [0, 0, 0.5, 0.5]
const UPPER_RIGHT: Rect = [0.5, 0, 0.5, 0.5]
const LOWER_LEFT: Rect = [0, 0.5, 0.5, 0.5]
const LOWER_RIGHT: Rect = [0.5, 0.5, 0.5, 0.5]

/**
 * Every block character by its code point, in at most two parts (`::before`, `::after`). Three
 * quadrants are two overlapping halves, so no seam shows inside the cell.
 */
export const BLOCK_SHAPES: ReadonlyMap<number, Shape> = (() => {
  const shapes = new Map<number, Shape>()
  shapes.set(0x2580, { rects: [TOP] }) // ▀
  for (let n = 1; n <= 7; n++) shapes.set(0x2580 + n, { rects: [[0, 1 - n / 8, 1, n / 8]] }) // ▁ … ▇
  shapes.set(0x2588, { rects: [FULL] }) // █
  for (let n = 1; n <= 7; n++) shapes.set(0x2590 - n, { rects: [[0, 0, n / 8, 1]] }) // ▏ … ▉
  shapes.set(0x2590, { rects: [RIGHT] }) // ▐
  ;[0.25, 0.5, 0.75].forEach((alpha, i) => shapes.set(0x2591 + i, { rects: [FULL], alpha })) // ░ ▒ ▓
  shapes.set(0x2594, { rects: [[0, 0, 1, 1 / 8]] }) // ▔
  shapes.set(0x2595, { rects: [[7 / 8, 0, 1 / 8, 1]] }) // ▕
  shapes.set(0x2596, { rects: [LOWER_LEFT] }) // ▖
  shapes.set(0x2597, { rects: [LOWER_RIGHT] }) // ▗
  shapes.set(0x2598, { rects: [UPPER_LEFT] }) // ▘
  shapes.set(0x2599, { rects: [LEFT, BOTTOM] }) // ▙
  shapes.set(0x259a, { rects: [UPPER_LEFT, LOWER_RIGHT] }) // ▚
  shapes.set(0x259b, { rects: [TOP, LEFT] }) // ▛
  shapes.set(0x259c, { rects: [TOP, RIGHT] }) // ▜
  shapes.set(0x259d, { rects: [UPPER_RIGHT] }) // ▝
  shapes.set(0x259e, { rects: [UPPER_RIGHT, LOWER_LEFT] }) // ▞
  shapes.set(0x259f, { rects: [RIGHT, BOTTOM] }) // ▟
  return shapes
})()

const BLOCK = /[▀-▟]/
const BOX_CLASS = 'cm-block'

/** A share of the cell in percent, without the dust of floating point (1 - 7/8 - 1/8). */
function percent(share: number): string {
  const value = Math.round(share * 10000) / 100
  return value === 0 ? '0' : `${value}%`
}

/** The style sheet that draws the boxes. */
export function blockGlyphsCss(): string {
  const box = `.xterm-rows .${BOX_CLASS}`
  const rules = [
    `${box} { position: relative; -webkit-text-fill-color: transparent; }`,
    `${box}::before, ${box}::after { position: absolute; background-color: currentColor; }`,
  ]
  for (const [code, { rects, alpha }] of BLOCK_SHAPES) {
    const selector = `${box}-${code.toString(16)}`
    if (alpha !== undefined) rules.push(`${selector} { opacity: ${alpha}; }`)
    rects.forEach(([x, y, w, h], i) => {
      const inset = [y, 1 - x - w, 1 - y - h, x].map(percent).join(' ')
      rules.push(`${selector}::${i === 0 ? 'before' : 'after'} { content: ''; inset: ${inset}; }`)
    })
  }
  return rules.join('\n')
}

/** `text` in runs of other characters and single block characters (as their code point). */
export function splitBlocks(text: string): (string | number)[] {
  const parts: (string | number)[] = []
  let plain = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (!BLOCK_SHAPES.has(code)) {
      plain += char
      continue
    }
    if (plain) parts.push(plain)
    plain = ''
    parts.push(code)
  }
  if (plain) parts.push(plain)
  return parts
}

/** Puts every block character of a row (its spans hold the text) into a box of its own; boxes made before stay. */
function drawRow(row: Element): void {
  if (!BLOCK.test(row.textContent ?? '')) return
  for (const span of row.children) {
    for (const node of [...span.childNodes]) {
      if (!(node instanceof Text) || !BLOCK.test(node.data)) continue
      node.replaceWith(
        ...splitBlocks(node.data).map((part) => {
          if (typeof part === 'string') return part
          const box = document.createElement('span')
          box.className = `${BOX_CLASS} ${BOX_CLASS}-${part.toString(16)}`
          box.textContent = String.fromCodePoint(part)
          return box
        }),
      )
    }
  }
}

let style: HTMLStyleElement | null = null

/**
 * Draws the block characters of `term` (opened already) without gaps while the DOM renderer draws it.
 * The rows are redrawn in an animation frame or on a link hover; the boxes come in right after,
 * before the browser paints. With WebGL there are no rows, and nothing to do.
 */
export function drawBlockGlyphs(term: Terminal): IDisposable {
  const element = term.element
  if (!element) return { dispose: () => {} }
  if (!style) {
    style = document.createElement('style')
    style.textContent = blockGlyphsCss()
    document.head.appendChild(style)
  }
  const observer = new MutationObserver((records) => {
    const rows = new Set<Element>()
    for (const { target } of records) {
      const row = target instanceof Element ? target.closest('.xterm-rows > div') : null
      if (row) rows.add(row)
    }
    rows.forEach(drawRow)
    // The changes made here: nothing more to do for them.
    observer.takeRecords()
  })
  observer.observe(element, { childList: true, subtree: true })
  element.querySelectorAll('.xterm-rows > div').forEach(drawRow)
  return { dispose: () => observer.disconnect() }
}
