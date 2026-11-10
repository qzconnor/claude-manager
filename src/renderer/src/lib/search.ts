import { foldCase } from '@shared/utils'

/** Fields of an item folded into one lower-case text, to test search terms against it. */
export function searchText(...fields: (string | null | undefined)[]): string {
  return foldCase(fields.filter(Boolean).join('\n'))
}

/** Whether every term occurs in a text made with `searchText`. */
export function containsTerms(text: string, terms: string[]): boolean {
  return terms.every((term) => text.includes(term))
}

export interface TextPart {
  text: string
  match: boolean
}

/** Lower case and without accents, a character for a character, so positions stay those of `text`. */
function foldAccents(text: string): string {
  let folded = ''
  for (const char of foldCase(text)) {
    const base = char.normalize('NFD').replace(/\p{M}+/gu, '')
    folded += base.length === char.length ? base : char
  }
  return folded
}

/**
 * Where the terms occur in `text` as `[start, end)`, sorted and merged; case and accents don't
 * count, like in the command palette's filter ("offnen" finds "öffnen").
 */
export function matchSpans(text: string, terms: string[]): [number, number][] {
  const folded = foldAccents(text)
  if (folded.length !== text.length) return []
  const marked = new Uint8Array(text.length)
  for (const term of terms.map(foldAccents)) {
    if (!term) continue
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + term.length)) {
      marked.fill(1, at, at + term.length)
    }
  }
  const spans: [number, number][] = []
  for (let i = 0; i < text.length; i++) {
    if (!marked[i]) continue
    const start = i
    while (i < text.length && marked[i]) i++
    spans.push([start, i])
  }
  return spans
}

/** Splits `text` where the terms occur, to highlight them. */
export function highlightParts(text: string, terms: string[]): TextPart[] {
  const folded = foldCase(text)
  if (terms.length === 0 || folded.length !== text.length) return [{ text, match: false }]
  const marked = new Uint8Array(text.length)
  for (const term of terms) {
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + term.length)) {
      marked.fill(1, at, at + term.length)
    }
  }
  const parts: TextPart[] = []
  let start = 0
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marked[i] !== marked[start]) {
      parts.push({ text: text.slice(start, i), match: marked[start] === 1 })
      start = i
    }
  }
  return parts
}
