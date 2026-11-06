import type { IDisposable, Terminal } from '@xterm/xterm'

export interface ColorSchemeSource {
  /** The background of the terminal theme, `#rrggbb`. */
  background: string
  dark: boolean
}

/** `#rrggbb` or `#rgb` the way terminals answer OSC 10/11: `rgb:rrrr/gggg/bbbb`. */
export function x11Color(hex: string): string | null {
  let digits = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())?.[1]
  if (!digits) return null
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join('')
  const channels = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)]
  return `rgb:${channels.map((c) => (c + c).toLowerCase()).join('/')}`
}

/**
 * Answers programs that ask which colors the terminal has, with the colors of the theme:
 * - OSC 11 (background color): xterm would answer with its own background, which is transparent
 *   black so the window material shows through. Claude Code's "Auto" theme picks dark or light
 *   from it.
 * - `CSI ? 996 n` (dark or light?), which xterm doesn't know.
 * Telling programs when the theme changes is done by the main process (TerminalService.setColorScheme).
 */
export function answerColorQueries(term: Terminal, source: () => ColorSchemeSource): IDisposable[] {
  const reply = (data: string) => term.input(data, false)
  return [
    term.parser.registerOscHandler(11, (data) => {
      if (data !== '?') return false
      const color = x11Color(source().background)
      if (!color) return false
      reply(`\x1b]11;${color}\x1b\\`)
      return true
    }),
    term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, (params) => {
      if (params.length !== 1 || params[0] !== 996) return false
      reply(`\x1b[?997;${source().dark ? 1 : 2}n`)
      return true
    }),
  ]
}
