/**
 * Claude Code paints its side panels (e.g. /diff) with a fixed gray from its own theme
 * (`composerSidebarBackground`: dark, light and light daltonized). With COLORTERM=truecolor it
 * arrives as `48;2;R;G;B`; exchanging it before xterm sees the output lets the panel follow the app.
 */
const PANEL_GRAYS = new Set(['38;38;38', '245;245;245', '235;235;235'])

const SGR_RE = /\x1b\[([0-9;]*)m/g
/** An escape sequence cut off at the end of a chunk. */
const PARTIAL_RE = /\x1b(\[[0-9;:]*)?$/
/** Extended colors: `38`/`48`/`58` followed by `2;R;G;B` or `5;N`. */
const EXTENDED_COLORS = new Set(['38', '48', '58'])

/** SGR parameters for a `#rgb` or `#rrggbb` color; null for anything else. */
export function sgrBackground(hex: string): string | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join('') : match[1]
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16))
  return `48;2;${r};${g};${b}`
}

function rewrite(params: string, replacement: string): string {
  const parts = params.split(';')
  for (let i = 0; i < parts.length; i++) {
    if (!EXTENDED_COLORS.has(parts[i])) continue
    if (parts[i + 1] === '5') {
      i += 2
    } else if (parts[i + 1] === '2') {
      if (parts[i] === '48' && PANEL_GRAYS.has(parts.slice(i + 2, i + 5).join(';'))) {
        parts.splice(i, 5, replacement)
      } else {
        i += 4
      }
    }
  }
  return parts.join(';')
}

/**
 * Returns a function that exchanges the panel gray in one terminal's output, chunk by chunk.
 * `replacement()` gives the SGR parameters to use (`49` = the terminal's own background) or null
 * to leave the output alone. A sequence cut off at the end of a chunk is held back until the
 * next one; xterm would wait for its end anyway.
 */
export function createPanelBackgroundFilter(replacement: () => string | null): (chunk: string) => string {
  let carry = ''
  return (chunk) => {
    let data = carry + chunk
    carry = ''
    const target = replacement()
    if (target === null) return data
    const partial = PARTIAL_RE.exec(data.slice(-64))
    if (partial) {
      carry = partial[0]
      data = data.slice(0, data.length - carry.length)
    }
    if (!data.includes('48;2;')) return data
    return data.replace(SGR_RE, (sequence, params: string) =>
      params.includes('48;2;') ? `\x1b[${rewrite(params, target)}m` : sequence,
    )
  }
}
