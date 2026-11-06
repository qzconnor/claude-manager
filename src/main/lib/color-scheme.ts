/** Private mode switches (`CSI ? Pm h` / `CSI ? Pm l`). */
const MODE_RE = /\x1b\[\?([\d;]+)([hl])/g
/** The start of such a switch at the end of a chunk; the rest comes with the next one. */
const PARTIAL_MODE_RE = /\x1b(\[(\?[\d;]*)?)?$/

/** The mode in which a program asks to be told when the terminal turns dark or light. */
const COLOR_SCHEME_UPDATES = '2031'

/**
 * Follows whether the program in a terminal asked for color scheme updates (`CSI ? 2031 h`, as in
 * Contour, Ghostty and kitty), also when the switch is split between two chunks. Claude Code asks
 * for them and then reads the background color again (OSC 11) to pick its "Auto" theme.
 */
export class ColorSchemeUpdates {
  enabled = false
  private pending = ''

  read(data: string): void {
    const text = this.pending + data
    this.pending = ''
    if (!text.includes('\x1b')) return
    for (const match of text.matchAll(MODE_RE)) {
      if (match[1].split(';').includes(COLOR_SCHEME_UPDATES)) this.enabled = match[2] === 'h'
    }
    this.pending = PARTIAL_MODE_RE.exec(text)?.[0] ?? ''
  }
}

/** What the terminal sends when it turned dark (1) or light (2), and the answer to `CSI ? 996 n`. */
export function colorSchemeReport(dark: boolean): string {
  return `\x1b[?997;${dark ? 1 : 2}n`
}

/**
 * Foreground and background as rxvt reports them (white on black, black on white). Programs that
 * can't ask the terminal read the background from it, Claude Code's "Auto" theme among them.
 */
export function colorFgBg(dark: boolean): string {
  return dark ? '15;0' : '0;15'
}
