import { foldCase } from '@shared/utils'

/**
 * A whole text in lower case and without accents ("Öffnen" → "offnen"), also where the accents are
 * characters of their own. In one pass, as lists fold all their items again for every search.
 */
function foldText(text: string): string {
  return foldCase(text).normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC')
}

/** Fields of an item folded into one text in lower case and without accents, to test search terms against it. */
export function searchText(...fields: (string | null | undefined)[]): string {
  return foldText(fields.filter(Boolean).join('\n'))
}

/** Whether every term occurs in a text made with `searchText`; accents in the terms don't count either ("offnen" finds "öffnen"). */
export function containsTerms(text: string, terms: string[]): boolean {
  return terms.every((term) => text.includes(foldText(term)))
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

/**
 * Each place `query` occurs in `text` as `[start, end)`, one after the other as a find in a page goes
 * through them; case and accents don't count, as in `matchSpans`. Spaces in `query` count.
 */
export function findSpans(text: string, query: string): [number, number][] {
  const needle = foldAccents(query)
  if (!needle) return []
  const folded = foldAccents(text)
  const spans: [number, number][] = []
  for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + needle.length)) spans.push([at, at + needle.length])
  return spans
}

/** Splits `text` where the terms occur, to highlight them; case and accents don't count, as in `matchSpans`. */
export function highlightParts(text: string, terms: string[]): TextPart[] {
  const spans = matchSpans(text, terms)
  if (spans.length === 0) return [{ text, match: false }]
  const parts: TextPart[] = []
  let at = 0
  for (const [start, end] of spans) {
    if (start > at) parts.push({ text: text.slice(at, start), match: false })
    parts.push({ text: text.slice(start, end), match: true })
    at = end
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false })
  return parts
}

/** The text node and offset at `position` of the nodes' joined text; an end prefers the node it ends in. */
export function locate(nodes: Text[], position: number, end: boolean): { node: Text; offset: number } {
  let rest = position
  for (const node of nodes) {
    const length = node.data.length
    if (rest < length || (end && rest === length)) return { node, offset: rest }
    rest -= length
  }
  const last = nodes[nodes.length - 1]
  return { node: last, offset: last.data.length }
}
