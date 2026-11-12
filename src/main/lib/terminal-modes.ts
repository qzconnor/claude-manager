/**
 * DEC private modes a replay has to bring back: they change how keys, the mouse and pasted text reach
 * the program (cursor keys 1, keypad 66, mouse 1000-1016, focus 1004, bracketed paste 2004), where the
 * output goes (origin 6, wraparound 7, alternate screen 47/1047/1049) and whether the cursor shows
 * (12, 25).
 */
const KEPT = new Set([1, 6, 7, 12, 25, 47, 66, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047, 1049, 2004])

/** `CSI ? Pm h` / `CSI ? Pm l`, and the keypad modes `ESC =` / `ESC >`. */
const MODE = /\x1b\[\?([\d;]*)([hl])|\x1b([=>])/g

/** A sequence cut off longer than this isn't one a terminal waits for: it is dropped. */
const MAX_OPEN = 4096

/** Where an escape sequence starts that `text` ends in the middle of; -1 when it ends between sequences. */
export function openSequenceStart(text: string): number {
  const esc = text.lastIndexOf('\x1b')
  if (esc === -1) return -1
  const rest = text.slice(esc)
  // A lone ESC, an unfinished CSI or one with intermediates (`ESC (`).
  if (/^\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*|[\x20-\x2f]*)$/.test(rest)) return esc
  // An OSC, DCS, SOS, PM or APC without its BEL (an ST would be a later ESC).
  if (/^\x1b[\]PX^_][^\x07]*$/.test(rest)) return esc
  return -1
}

/**
 * The state of the terminal modes in output a tab no longer keeps (see `MAX_BUFFER_CHARS`): a view
 * that replays the rest would miss them, e.g. bracketed paste (pasted text would run as typed lines),
 * the mouse or the alternate screen.
 */
export class TrimmedModes {
  /** In the order they last changed. */
  private readonly modes = new Map<number, boolean>()
  private keypad: boolean | null = null
  /** The start of a sequence at the end of the trimmed output; the kept output goes on with its rest. */
  private open = ''

  /** Takes in output dropped from the front of the buffer, in order. */
  trim(data: string): void {
    let text = this.open + data
    const cut = openSequenceStart(text)
    this.open = cut === -1 || text.length - cut > MAX_OPEN ? '' : text.slice(cut)
    if (cut !== -1) text = text.slice(0, cut)
    for (const [, params, set, keypad] of text.matchAll(MODE)) {
      if (keypad) {
        this.keypad = keypad === '='
        continue
      }
      for (const param of params.split(';')) {
        const mode = Number(param)
        if (!KEPT.has(mode)) continue
        this.modes.delete(mode)
        this.modes.set(mode, set === 'h')
      }
    }
  }

  /** What a view writes before the kept output, so it ends up as if it had seen all of it. */
  prefix(): string {
    let out = ''
    for (const [mode, on] of this.modes) out += `\x1b[?${mode}${on ? 'h' : 'l'}`
    if (this.keypad !== null) out += this.keypad ? '\x1b=' : '\x1b>'
    return out + this.open
  }
}
