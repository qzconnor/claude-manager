import type { IDisposable, Terminal } from '@xterm/xterm'

/**
 * The sequences fonts with ligatures for code (JetBrains Mono, Fira Code, Cascadia Code, Iosevka …)
 * draw as one sign: the calt set of Iosevka, which @xterm/addon-ligatures also falls back to.
 */
const LIGATURES = [
  '<--', '<---', '<<-', '<-', '->', '->>', '-->', '--->',
  '<==', '<===', '<<=', '<=', '=>', '=>>', '==>', '===>', '>=', '>>=',
  '<->', '<-->', '<--->', '<---->', '<=>', '<==>', '<===>', '<====>', '::', ':::',
  '<~~', '</', '</>', '/>', '~~>', '==', '!=', '/=', '~=', '<>', '===', '!==', '!===',
  '<:', ':=', '*=', '*+', '<*', '<*>', '*>', '<|', '<|>', '|>', '+*', '=*', '=:', ':>',
  '/*', '*/', '+++', '<!--', '<!---',
]

/** The ligatures by their first character, longest first: the longest one at a place wins. */
const BY_FIRST = new Map<string, string[]>()
for (const ligature of [...LIGATURES].sort((a, b) => b.length - a.length)) {
  const list = BY_FIRST.get(ligature[0]) ?? []
  list.push(ligature)
  BY_FIRST.set(ligature[0], list)
}

/**
 * Where `text` holds ligatures, as [start, end) offsets. A sequence that goes on with the same
 * character, like `==` in a line of `=====` or `->` at the end of `------>`, is no ligature: joined
 * piece by piece, such lines would turn into a row of separate signs.
 */
export function ligatureRanges(text: string): [number, number][] {
  const ranges: [number, number][] = []
  for (let i = 0; i < text.length - 1; i++) {
    const candidates = BY_FIRST.get(text[i])
    if (!candidates || text[i - 1] === text[i]) continue
    const hit = candidates.find((l) => text.startsWith(l, i) && text[i + l.length] !== l[l.length - 1])
    if (!hit) continue
    ranges.push([i, i + hit.length])
    i += hit.length - 1
  }
  return ranges
}

/** Features of the font for ligatures in code (contextual alternates) and the standard ones. */
const FEATURES_ON = '"calt" 1, "liga" 1'
const FEATURES_OFF = '"calt" 0, "liga" 0'

export interface Ligatures extends IDisposable {
  /** Applies `enabled()` again and redraws the rows when that changed. */
  update(): void
}

/**
 * Draws sequences like `=>` in `term` (opened already) as the font's ligatures while `enabled()`.
 *
 * The DOM renderer leaves it to the font, which needs its features switched on: xterm gives the rows
 * a letter-spacing of a fraction of a pixel to keep them in the grid, and Chromium turns ligatures
 * off for any letter-spacing. WebGL draws every cell on its own; the sequences are joined (character
 * joiner) and drawn as one text. That only while `joined()`, i.e. WebGL draws: the DOM renderer would
 * give the letter-spacing of a whole joined group to each of its characters, which pushes the rest
 * of the row out of the grid at a letter spacing other than 0.
 */
export function drawLigatures(term: Terminal, enabled: () => boolean, joined: () => boolean): Ligatures {
  const element = term.element
  const joiner = term.registerCharacterJoiner((text) => (enabled() && joined() ? ligatureRanges(text) : []))
  let drawn = enabled()
  if (element) element.style.fontFeatureSettings = drawn ? FEATURES_ON : FEATURES_OFF
  return {
    update() {
      const on = enabled()
      if (element) element.style.fontFeatureSettings = on ? FEATURES_ON : FEATURES_OFF
      if (on === drawn) return
      drawn = on
      term.refresh(0, term.rows - 1)
    },
    dispose() {
      term.deregisterCharacterJoiner(joiner)
      if (element) element.style.fontFeatureSettings = ''
    },
  }
}
