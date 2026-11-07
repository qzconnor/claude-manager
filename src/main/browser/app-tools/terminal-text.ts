/**
 * Terminal output as plain text: escape sequences out, carriage returns and erasing applied.
 * Moves of the cursor to another row start a new line, so nothing is lost, though a part a
 * program draws again may show twice.
 */
export function terminalText(raw: string): string {
  const lines: string[][] = [[]]
  let row = 0
  let col = 0
  /** Row of the last absolute cursor move, followed through line feeds. */
  let screenRow: number | null = null
  const line = () => lines[row]
  const newLine = () => {
    row++
    if (!lines[row]) lines[row] = []
    col = 0
    if (screenRow !== null) screenRow++
  }
  const put = (ch: string) => {
    const l = line()
    while (l.length < col) l.push(' ')
    l[col] = ch
    col++
  }
  const params = (text: string) => text.replace(/^[?>=<]/, '').split(';').map((p) => (p === '' ? NaN : Number(p)))
  const n = (value: number, fallback = 1) => (Number.isFinite(value) && value > 0 ? value : fallback)

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    const code = c.charCodeAt(0)
    if (c === '\x1b') {
      const next = raw[i + 1]
      if (next === '[') {
        let j = i + 2
        while (j < raw.length && /[0-?]/.test(raw[j])) j++
        const paramText = raw.slice(i + 2, j)
        while (j < raw.length && /[ -/]/.test(raw[j])) j++
        const final = raw[j]
        i = j
        if (final === undefined) break
        const p = params(paramText)
        const private_ = /^[?>=<]/.test(paramText)
        if (private_) continue
        switch (final) {
          case 'K': {
            const mode = Number.isFinite(p[0]) ? p[0] : 0
            const l = line()
            if (mode === 0) l.length = Math.min(l.length, col)
            else if (mode === 1) for (let k = 0; k <= col && k < l.length; k++) l[k] = ' '
            else lines[row] = []
            break
          }
          case 'J': {
            const mode = Number.isFinite(p[0]) ? p[0] : 0
            if (mode === 2 || mode === 3) {
              if (line().length) newLine()
              screenRow = 1
              col = 0
            } else if (mode === 0) {
              line().length = Math.min(line().length, col)
              lines.length = row + 1
            }
            break
          }
          case 'H':
          case 'f': {
            const r = n(p[0])
            const target = n(p[1]) - 1
            // Unknown row (output read from the middle): a new line, so nothing is overwritten.
            if ((screenRow === null || r !== screenRow) && line().length) newLine()
            screenRow = r
            col = target
            break
          }
          case 'd': {
            const r = n(p[0])
            if ((screenRow === null || r !== screenRow) && line().length) newLine()
            screenRow = r
            break
          }
          case 'A':
          case 'F':
            row = Math.max(0, row - n(p[0]))
            if (screenRow !== null) screenRow = Math.max(1, screenRow - n(p[0]))
            if (final === 'F') col = 0
            break
          case 'B':
          case 'E':
            for (let k = 0; k < n(p[0]); k++) {
              const keep = col
              newLine()
              if (final === 'B') col = keep
            }
            break
          case 'C':
            col += n(p[0])
            break
          case 'D':
            col = Math.max(0, col - n(p[0]))
            break
          case 'G':
            col = n(p[0]) - 1
            break
          case 'X': {
            const l = line()
            for (let k = col; k < col + n(p[0]) && k < l.length; k++) l[k] = ' '
            break
          }
          case 'P':
            line().splice(col, n(p[0]))
            break
          case '@':
            if (col < line().length) line().splice(col, 0, ...' '.repeat(n(p[0])))
            break
          default:
            // Colors (m), modes, scroll regions and the like don't change the text.
            break
        }
        continue
      }
      if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
        // OSC, DCS, APC, PM, SOS: up to BEL or ST.
        let j = i + 2
        while (j < raw.length && raw[j] !== '\x07' && !(raw[j] === '\x1b' && raw[j + 1] === '\\')) j++
        i = raw[j] === '\x07' ? j : j + 1
        continue
      }
      if (next === '(' || next === ')' || next === '*' || next === '+') {
        i += 2
        continue
      }
      if (next === 'M') row = Math.max(0, row - 1)
      i += 1
      continue
    }
    if (c === '\r') {
      col = 0
      continue
    }
    if (c === '\n') {
      newLine()
      continue
    }
    if (c === '\b') {
      col = Math.max(0, col - 1)
      continue
    }
    if (c === '\t') {
      const stop = (Math.floor(col / 8) + 1) * 8
      while (col < stop) put(' ')
      continue
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) continue
    put(c)
  }

  const out: string[] = []
  let blank = 0
  for (const l of lines) {
    const text = (l ?? []).join('').replace(/\s+$/, '')
    if (!text) {
      blank++
      continue
    }
    if (blank && out.length) out.push('')
    blank = 0
    out.push(text)
  }
  return out.join('\n')
}
