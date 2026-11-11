/** A changed part of a line: from `start` up to `end` (characters). */
export type Range = readonly [start: number, end: number]

/** Lines longer than this aren't compared word by word (minified code). */
export const MAX_WORD_DIFF_CHARS = 1000
/** Above this many token pairs the middle of the lines counts as changed whole. */
const MAX_CELLS = 40_000
/** Less than this share of the longer line in common: the line changed whole, nothing is marked in it. */
const MIN_COMMON = 0.3

/** Words (letters, digits, `_`), runs of spaces, and every other character by itself. */
const TOKEN_RE = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu

function tokens(text: string): string[] {
  return text.match(TOKEN_RE) ?? []
}

/**
 * What changed between a removed line `a` and the added line `b` in its place, word by word: the
 * ranges of each that the other doesn't have. Null when there is nothing to mark: the lines are the
 * same, too long, or have too little in common for marks to help.
 */
export function changedRanges(a: string, b: string): { a: Range[]; b: Range[] } | null {
  if (a === b || a.length > MAX_WORD_DIFF_CHARS || b.length > MAX_WORD_DIFF_CHARS) return null
  const ta = tokens(a)
  const tb = tokens(b)
  // What both start and end with is the same; only the middle is compared.
  let start = 0
  while (start < ta.length && start < tb.length && ta[start] === tb[start]) start++
  let end = 0
  while (end < ta.length - start && end < tb.length - start && ta[ta.length - 1 - end] === tb[tb.length - 1 - end]) end++
  const ma = ta.slice(start, ta.length - end)
  const mb = tb.slice(start, tb.length - end)
  const keptA = new Array<boolean>(ma.length).fill(false)
  const keptB = new Array<boolean>(mb.length).fill(false)
  if (ma.length * mb.length <= MAX_CELLS) commonTokens(ma, mb, keptA, keptB)

  const common = sharedLength(ta, start, end, ma, keptA)
  if (common < MIN_COMMON * Math.max(a.length, b.length)) return null
  return { a: rangesOf(ta, start, keptA), b: rangesOf(tb, start, keptB) }
}

/** Marks the tokens of the longest common subsequence of `a` and `b` as kept. */
function commonTokens(a: string[], b: string[], keptA: boolean[], keptB: boolean[]): void {
  const n = a.length
  const m = b.length
  // lengths[i][j]: of the common subsequence of a[i..] and b[j..].
  const lengths = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      keptA[i++] = true
      keptB[j++] = true
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++
    else j++
  }
}

/** Characters the line shares with the other: its same start and end, and the kept tokens between. */
function sharedLength(all: string[], start: number, end: number, middle: string[], kept: boolean[]): number {
  let length = 0
  for (let i = 0; i < start; i++) length += all[i]!.length
  for (let i = all.length - end; i < all.length; i++) length += all[i]!.length
  middle.forEach((token, i) => {
    if (kept[i]) length += token.length
  })
  return length
}

/**
 * The changed tokens as character ranges: those of the middle not kept. A space between two changes
 * joins them, as a reader sees them; spaces at a range's edges are left out of it.
 */
function rangesOf(all: string[], start: number, kept: boolean[]): Range[] {
  const changed = all.map((_, i) => i >= start && i < start + kept.length && !kept[i - start])
  for (let i = 1; i < all.length - 1; i++) {
    if (!changed[i] && /^\s+$/.test(all[i]!) && changed[i - 1] && changed[i + 1]) changed[i] = true
  }
  const ranges: [number, number][] = []
  let offset = 0
  all.forEach((token, i) => {
    if (changed[i]) {
      const last = ranges[ranges.length - 1]
      if (last && last[1] === offset) last[1] += token.length
      else ranges.push([offset, offset + token.length])
    }
    offset += token.length
  })
  const text = all.join('')
  for (const range of ranges) {
    while (range[0] < range[1] && /\s/.test(text[range[0]]!)) range[0]++
    while (range[1] > range[0] && /\s/.test(text[range[1] - 1]!)) range[1]--
  }
  return ranges.filter((range) => range[1] > range[0])
}

/** The text in parts, each marked as changed or not; for drawing the marks. */
export function splitByRanges(text: string, ranges: readonly Range[]): { text: string; changed: boolean }[] {
  const parts: { text: string; changed: boolean }[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start >= text.length) break
    if (start > at) parts.push({ text: text.slice(at, start), changed: false })
    parts.push({ text: text.slice(start, Math.min(end, text.length)), changed: true })
    at = Math.min(end, text.length)
  }
  if (at < text.length) parts.push({ text: text.slice(at), changed: false })
  return parts
}
