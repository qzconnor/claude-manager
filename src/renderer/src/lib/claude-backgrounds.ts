import type { DiffColors, PanelBackground } from '@shared/types'
import type { TerminalPalette } from '@shared/themes/types'

/**
 * Claude Code paints some areas with fixed background colors from its own themes. With
 * COLORTERM=truecolor they arrive as `48;2;R;G;B`; exchanging them before xterm sees the output
 * lets these areas follow the app.
 *
 * A replacement is written as a 256-color palette slot, not as RGB: xterm looks a palette color up
 * only when it draws, so cells already on screen follow a theme change. The slots are drawn
 * see-through (see translucent-slots.ts); the xterm theme holds an opaque mix of each for
 * everything else xterm does with the color (`slotPalette`). Programs that use these slots
 * themselves get the slot's standard color as RGB instead, so their output looks as before.
 */
export const SLOTS = {
  panel: 16,
  added: 17,
  addedWord: 18,
  addedDimmed: 19,
  removed: 20,
  removedWord: 21,
  removedDimmed: 22,
} as const
export type Slot = keyof typeof SLOTS
export const SLOT_NAMES = Object.keys(SLOTS) as Slot[]

/** A see-through color: `color` (hex) with `alpha` from 0 to 1. */
export interface SlotTint {
  color: string
  alpha: number
}
export type SlotTints = Record<Slot, SlotTint>

const DIFF_SLOTS = ['added', 'addedWord', 'addedDimmed', 'removed', 'removedWord', 'removedDimmed'] as const

/** Claude Code's colors behind each slot, as `R;G;B`. */
const CLAUDE_COLORS: Record<Slot, string[]> = {
  // Dark, light and light daltonized theme: side panels such as /diff (composerSidebarBackground),
  // the bars behind the user's own messages (userMessageBackground) and behind `!` bash and `#`
  // memory input. The lighter hover gray of a message stays, so hovering still highlights it.
  panel: [
    ...['38;38;38', '245;245;245', '235;235;235'],
    ...['55;55;55', '240;240;240', '220;220;220'],
    ...['65;60;65', '250;245;250'],
    ...['55;65;70', '230;245;250'],
  ],
  // First the syntax highlighted diff of Update and Write (dark, light), then the plain diff of the
  // theme (dark, light). The daltonized themes keep their blue for added lines; they share the
  // highlighted diff's red with the other themes.
  added: ['2;40;0', '220;255;220', '34;92;43', '105;219;124'],
  addedWord: ['4;71;0', '178;255;178', '56;166;96', '47;157;68'],
  addedDimmed: ['71;88;74', '199;225;203'],
  removed: ['61;1;0', '255;220;220', '122;41;54', '255;168;180'],
  removedWord: ['92;2;0', '255;199;199', '179;89;107', '209;69;75'],
  removedDimmed: ['105;72;77', '253;210;216'],
}

/** How much of the tint color covers what lies behind, from 0 to 1. */
const ALPHA = { panel: 0.07, line: 0.15, word: 0.3, dimmed: 0.08 }

const slotSgr = (slot: Slot) => `48;5;${SLOTS[slot]}`

/** Claude's `R;G;B` backgrounds mapped to the SGR parameters that replace them. */
export function backgroundReplacements(panel: PanelBackground, diff: DiffColors): Map<string, string> {
  const map = new Map<string, string>()
  const replace = (slot: Slot, sgr: string) => CLAUDE_COLORS[slot].forEach((rgb) => map.set(rgb, sgr))
  // `49` is the terminal's own background, which lets the window material shine through.
  if (panel !== 'original') replace('panel', panel === 'theme' ? slotSgr('panel') : '49')
  if (diff === 'theme') DIFF_SLOTS.forEach((slot) => replace(slot, slotSgr(slot)))
  return map
}

/** The slots in a theme: panels lightly tinted with its text color, diffs with its green and red. */
export function themeSlotTints(palette: TerminalPalette): SlotTints {
  const { foreground, green, red } = palette
  return {
    panel: { color: foreground, alpha: ALPHA.panel },
    added: { color: green, alpha: ALPHA.line },
    addedWord: { color: green, alpha: ALPHA.word },
    addedDimmed: { color: green, alpha: ALPHA.dimmed },
    removed: { color: red, alpha: ALPHA.line },
    removedWord: { color: red, alpha: ALPHA.word },
    removedDimmed: { color: red, alpha: ALPHA.dimmed },
  }
}

/** `[r, g, b]` from 0 to 255 for a `#rgb` or `#rrggbb` color; null for anything else. */
export function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!match) return null
  const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join('') : match[1]
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number]
}

/** `tint` laid over `base` as one opaque hex color; the tint's color if either is not hex. */
function flatten(base: string, tint: SlotTint): string {
  const [from, to] = [parseHex(base), parseHex(tint.color)]
  if (!from || !to) return tint.color
  const mixed = from.map((value, i) => Math.round(value + (to[i] - value) * tint.alpha))
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

/**
 * `extendedAnsi` for the xterm theme (colors 16 to 255): each slot as it looks over the terminal
 * background, which xterm uses to draw the glyphs and for the minimum contrast. The other colors
 * stay standard.
 */
export function slotPalette(tints: SlotTints, background: string): string[] {
  const extended: string[] = []
  for (const slot of SLOT_NAMES) extended[SLOTS[slot] - 16] = flatten(background, tints[slot])
  return extended
}

const SLOT_INDICES = new Set<string>(Object.values(SLOTS).map(String))
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]

/** The standard color of a slot of the 6×6×6 color cube as `R;G;B`. */
function standardRgb(index: string): string {
  const n = Number(index) - 16
  return [Math.floor(n / 36), Math.floor(n / 6) % 6, n % 6].map((level) => CUBE_LEVELS[level]).join(';')
}

const SGR_RE = /\x1b\[([0-9;:]*)m/g
/** An escape sequence cut off at the end of a chunk. */
const PARTIAL_RE = /\x1b(\[[0-9;:]*)?$/
/** Extended colors: `38`/`48`/`58` followed by `2;R;G;B` or `5;N`. */
const EXTENDED_COLORS = new Set(['38', '48', '58'])
/** The colon form keeps a color in one parameter, e.g. `38:5:16`. */
const COLON_SLOT_RE = /^([345]8):5:(\d+)$/
/** A program's use of a slot, e.g. `38;5;17`. */
const SLOT_USE_RE = new RegExp(`[345]8[;:]5[;:](?:${[...SLOT_INDICES].join('|')})(?![0-9])`)

function rewrite(params: string, replacements: ReadonlyMap<string, string>): string {
  const parts = params.split(';')
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.includes(':')) {
      const colon = COLON_SLOT_RE.exec(part)
      if (colon && SLOT_INDICES.has(colon[2])) parts[i] = `${colon[1]};2;${standardRgb(colon[2])}`
      continue
    }
    if (!EXTENDED_COLORS.has(part)) continue
    if (parts[i + 1] === '5') {
      const index = parts[i + 2]
      if (SLOT_INDICES.has(index)) parts.splice(i + 1, 2, '2', standardRgb(index))
      i += 2
    } else if (parts[i + 1] === '2') {
      const replacement = part === '48' ? replacements.get(parts.slice(i + 2, i + 5).join(';')) : undefined
      if (replacement) parts.splice(i, 5, replacement)
      else i += 4
    }
  }
  return parts.join(';')
}

/** Whether a piece of output may hold a sequence that `rewrite` changes. */
function mayNeedRewrite(data: string): boolean {
  return data.includes('48;2;') || SLOT_USE_RE.test(data)
}

/**
 * Returns a function that exchanges Claude's backgrounds in one terminal's output, chunk by chunk,
 * as `replacements()` maps them (see `backgroundReplacements`). A sequence cut off at the end of a
 * chunk is held back until the next one; xterm would wait for its end anyway.
 */
export function createBackgroundFilter(replacements: () => ReadonlyMap<string, string>): (chunk: string) => string {
  let carry = ''
  return (chunk) => {
    let data = carry + chunk
    carry = ''
    const partial = PARTIAL_RE.exec(data.slice(-64))
    if (partial) {
      carry = partial[0]
      data = data.slice(0, data.length - carry.length)
    }
    if (!mayNeedRewrite(data)) return data
    const map = replacements()
    return data.replace(SGR_RE, (sequence, params: string) =>
      mayNeedRewrite(params) ? `\x1b[${rewrite(params, map)}m` : sequence,
    )
  }
}
