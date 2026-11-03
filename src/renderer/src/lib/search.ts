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
