/** Longest unfinished escape sequence kept for the next chunk; a title is never that long. */
const MAX_PENDING_CHARS = 4096

/**
 * Picks the window titles a program sets out of its output (OSC 0 and OSC 2), also when a
 * sequence is split between two chunks. ConPTY passes `SetConsoleTitle` on as OSC 0.
 */
export class TitleReader {
  private pending = ''

  /** The last title set in `data`, or null when it sets none. */
  read(data: string): string | null {
    const text = this.pending + data
    this.pending = ''
    let title: string | null = null
    let start = text.indexOf('\x1b]')
    while (start !== -1) {
      const end = findTerminator(text, start + 2)
      if (!end) {
        if (text.length - start <= MAX_PENDING_CHARS) this.pending = text.slice(start)
        return title
      }
      const body = text.slice(start + 2, end.index)
      if (body.startsWith('0;') || body.startsWith('2;')) title = body.slice(2)
      start = text.indexOf('\x1b]', end.index + end.length)
    }
    // A lone ESC at the end may start the next sequence.
    if (text.endsWith('\x1b')) this.pending = '\x1b'
    return title
  }
}

/** BEL or ST (ESC \), whichever comes first. */
function findTerminator(text: string, from: number): { index: number; length: number } | null {
  const bel = text.indexOf('\x07', from)
  const st = text.indexOf('\x1b\\', from)
  if (bel === -1 && st === -1) return null
  return st === -1 || (bel !== -1 && bel < st) ? { index: bel, length: 1 } : { index: st, length: 2 }
}

/**
 * What Claude Code's window title says: `◐`/`◑` in front while it works, `✳` while it waits for
 * the user (done, or a permission prompt). Older versions animated braille dots instead.
 */
export function claudeActivity(title: string): 'busy' | 'idle' | null {
  if (title.startsWith('✳ ')) return 'idle'
  return /^[◐◑⠀-⣿] /.test(title) ? 'busy' : null
}
