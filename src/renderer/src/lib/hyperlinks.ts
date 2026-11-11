import type { IBuffer, IBufferRange } from '@xterm/xterm'

/** `https://`, a closing slash and case don't matter for what a link shows. */
function bare(text: string): string {
  return text
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '')
    .toLowerCase()
}

/**
 * Whether the text of a link (OSC 8) shows where it leads: the URL itself, with or without `https://`.
 * Otherwise the text may name another site than the one it opens.
 */
export function showsTarget(text: string, uri: string): boolean {
  const shown = bare(text)
  return shown !== '' && shown === bare(uri)
}

/** The text a link (OSC 8) shows in the terminal; its range is 1-based, the end included. */
export function linkText(buffer: IBuffer, range: IBufferRange): string {
  let text = ''
  for (let y = range.start.y; y <= range.end.y; y++) {
    const line = buffer.getLine(y - 1)
    if (!line) continue
    text += line.translateToString(true, y === range.start.y ? range.start.x - 1 : 0, y === range.end.y ? range.end.x : undefined)
  }
  return text
}
