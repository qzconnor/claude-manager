/** Lines of the pasted text the question shows, and how many characters of each. */
const PREVIEW_LINES = 8
const PREVIEW_WIDTH = 120

/**
 * Whether pasted text would run commands on its own: it holds a line break, and the program doesn't
 * take it as one paste (bracketed paste, as Claude Code, bash 5.1 and zsh do), so a shell runs each
 * line, a trailing break included, as soon as it arrives.
 */
export function pasteRunsLines(text: string, bracketed: boolean): boolean {
  return !bracketed && /[\r\n]/.test(text)
}

/** The start of the pasted text for the question, with how many lines more there are. */
export function pastePreview(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  const shown = lines.slice(0, PREVIEW_LINES).map((line) => (line.length > PREVIEW_WIDTH ? `${line.slice(0, PREVIEW_WIDTH)}…` : line))
  const more = lines.length - shown.length
  if (more > 0) shown.push(more === 1 ? '… und 1 weitere Zeile' : `… und ${more} weitere Zeilen`)
  return shown.join('\n')
}
