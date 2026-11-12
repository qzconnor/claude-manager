import { Terminal, type IDecoration } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promptRows, turnMarks, turnTarget } from './turn-marks'

/** Claude Code's background behind the user's messages (`userMessageBackground`). */
const BG = '\x1b[48;2;55;55;55m'
const RESET = '\x1b[0m'
/** A message of the user as Claude Code shows it: pointer and text on a bar of their own background. */
const prompt = (text: string) => `${BG}❯ ${text}${RESET}`
/** Claude Code's input box: the pointer and a no-break space, without a background. */
const INPUT = ['─'.repeat(30), '❯ ', '─'.repeat(30)]

function terminal(rows = 6): Terminal {
  return new Terminal({ allowProposedApi: true, cols: 40, rows, scrollback: 1000 })
}

const write = (term: Terminal, ...lines: string[]) => new Promise<void>((resolve) => term.write(lines.join('\r\n'), resolve))

/** Some lines of output from Claude. */
const answer = (n: number) => Array.from({ length: n }, (_, i) => `● Zeile ${i + 1}`)

describe('promptRows', () => {
  it("finds the rows where the user's messages start", async () => {
    const term = terminal()
    await write(term, prompt('erste Frage'), ...answer(3), prompt('zweite'), ...answer(2), ...INPUT)
    expect(promptRows(term.buffer.active)).toEqual([0, 4])
  })

  it('takes the background of the palette as well, which the app puts for the colors of Claude Code', async () => {
    const term = terminal()
    await write(term, '\x1b[48;5;16m❯ Frage\x1b[0m', ...answer(2))
    expect(promptRows(term.buffer.active)).toEqual([0])
  })

  it('leaves out the input box and output that only starts with the pointer', async () => {
    const term = terminal()
    await write(term, ...INPUT, '❯ ohne Hintergrund', `${BG}❯x${RESET}`, `${BG} ❯ eingerückt${RESET}`)
    expect(promptRows(term.buffer.active)).toEqual([])
  })

  it('takes a pointer with a no-break space or nothing after it on the bar', async () => {
    const term = terminal()
    await write(term, `${BG}❯ Frage${RESET}`, `${BG}❯${' '.repeat(10)}${RESET}`, `${BG}❯${RESET}`)
    expect(promptRows(term.buffer.active)).toEqual([0, 1, 2])
  })

  it('counts a long message once, not the rows it wraps into', async () => {
    const term = terminal()
    // 40 columns: the second half starts a wrapped row with the pointer and a space again.
    await write(term, `${BG}❯ ${'a'.repeat(38)}❯ zweite Hälfte${RESET}`, ...answer(1))
    expect(term.buffer.active.getLine(1)?.isWrapped).toBe(true)
    expect(promptRows(term.buffer.active)).toEqual([0])
  })
})

describe('turnTarget', () => {
  // The prompts in rows 5, 20 and 40 put the rows 4, 19 and 39 at the top.
  const rows = [5, 20, 40]

  it('goes up to the prompt before the top of the view', () => {
    expect(turnTarget(rows, 60, -1)).toBe(39)
    expect(turnTarget(rows, 39, -1)).toBe(19)
    expect(turnTarget(rows, 30, -1)).toBe(19)
    expect(turnTarget(rows, 19, -1)).toBe(4)
    expect(turnTarget(rows, 4, -1)).toBeNull()
    expect(turnTarget(rows, 0, -1)).toBeNull()
  })

  it('goes down to the prompt after the top of the view', () => {
    expect(turnTarget(rows, 0, 1)).toBe(4)
    expect(turnTarget(rows, 4, 1)).toBe(19)
    expect(turnTarget(rows, 25, 1)).toBe(39)
    expect(turnTarget(rows, 39, 1)).toBeNull()
    expect(turnTarget(rows, 60, 1)).toBeNull()
  })

  it('puts a prompt in the first row at the top', () => {
    expect(turnTarget([0, 9], 8, -1)).toBe(0)
    expect(turnTarget([0, 9], 0, 1)).toBe(8)
    expect(turnTarget([], 5, -1)).toBeNull()
  })
})

describe('turnMarks', () => {
  let term: Terminal
  let decorations: IDecoration[]
  let color: string
  let shown: boolean
  /** Asked once each time the prompts are looked for. */
  let colorOf: () => string

  beforeEach(() => {
    vi.stubGlobal('window', globalThis)
    term = terminal()
    color = '#d97757'
    shown = true
    colorOf = vi.fn(() => color)
    const register = term.registerDecoration.bind(term)
    decorations = []
    vi.spyOn(term, 'registerDecoration').mockImplementation((options) => {
      const decoration = register(options)
      if (decoration) decorations.push(decoration)
      return decoration
    })
  })

  afterEach(() => {
    term.dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const start = () => turnMarks(term, { color: colorOf, shown: () => shown })
  /** The rows marked beside the scrollbar, with their color. */
  const marked = () =>
    decorations
      .filter((d) => !d.isDisposed)
      .map((d) => [d.marker.line, d.options.overviewRulerOptions?.color, d.options.overviewRulerOptions?.position])

  it('marks each prompt once beside the scrollbar, in the color asked for', async () => {
    const marks = start()
    await write(term, prompt('eins'), ...answer(8), prompt('zwei'), ...answer(8), ...INPUT)
    marks.refresh()
    expect(marked()).toEqual([
      [0, '#d97757', 'full'],
      [9, '#d97757', 'full'],
    ])
    marks.refresh()
    expect(decorations).toHaveLength(2)

    await write(term, '', prompt('drei'), ...answer(2))
    marks.refresh()
    expect(marked().map(([line]) => line)).toEqual([0, 9, 21])
    expect(decorations).toHaveLength(3)
  })

  it('marks them anew in the new color', async () => {
    const marks = start()
    await write(term, prompt('eins'), ...answer(2))
    marks.refresh()
    color = '#3b82f6'
    marks.refresh()
    expect(marked()).toEqual([[0, '#3b82f6', 'full']])
    expect(decorations[0]!.isDisposed).toBe(true)
  })

  it('follows Claude Code drawing the conversation anew', async () => {
    const marks = start()
    await write(term, prompt('eins'), ...answer(8), prompt('zwei'), ...answer(2))
    marks.refresh()
    // A resize or /clear: the screen and the scrollback go, the conversation comes again from the top.
    await write(term, '\x1b[2J\x1b[3J\x1b[H' + answer(2).join('\r\n'), prompt('zwei'), ...answer(1))
    expect(marked()).toEqual([])
    marks.refresh()
    expect(marked().map(([line]) => line)).toEqual([2])
  })

  it('drops a mark whose row has another text now', async () => {
    const marks = start()
    await write(term, prompt('eins'), ...answer(1))
    marks.refresh()
    await write(term, '\x1b[H\x1b[2K● überschrieben')
    marks.refresh()
    expect(marked()).toEqual([])
  })

  it('looks for prompts while output comes, at most every half second, only while shown', async () => {
    vi.useFakeTimers()
    const marks = start()
    term.write(prompt('eins') + '\r\n')
    await vi.advanceTimersByTimeAsync(100)
    term.write(answer(3).join('\r\n'))
    await vi.advanceTimersByTimeAsync(300)
    expect(marked()).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(marked().map(([line]) => line)).toEqual([0])
    // Once for both writes.
    await vi.advanceTimersByTimeAsync(1000)
    expect(colorOf).toHaveBeenCalledOnce()

    shown = false
    term.write('\r\n' + prompt('zwei'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(marked().map(([line]) => line)).toEqual([0])
    marks.refresh()
    expect(marked().map(([line]) => line)).toEqual([0, 4])
    marks.dispose()
  })

  it('leaves a full-screen program alone', async () => {
    const marks = start()
    await write(term, prompt('eins'), '\x1b[?1049h', prompt('im Vollbild'))
    marks.refresh()
    expect(marked()).toEqual([])
    expect(marks.jump(-1)).toBe(false)
  })

  it('takes the marks away when disposed', async () => {
    vi.useFakeTimers()
    const marks = start()
    term.write(prompt('eins'))
    await vi.advanceTimersByTimeAsync(600)
    expect(marked()).toHaveLength(1)
    marks.dispose()
    expect(marked()).toEqual([])
    term.write('\r\n' + prompt('zwei'))
    await vi.advanceTimersByTimeAsync(10)
    // It no longer listens to the output.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    marks.refresh()
    expect(marked()).toEqual([])
  })

  it('jumps from prompt to prompt and down to the end after the last', async () => {
    const marks = start()
    expect(marks.jump(-1)).toBe(false)
    await write(term, ...answer(3), prompt('eins'), ...answer(10), prompt('zwei'), ...answer(10), ...INPUT)
    const bottom = term.buffer.active.baseY
    expect(term.buffer.active.viewportY).toBe(bottom)

    expect(marks.jump(-1)).toBe(true)
    expect(term.buffer.active.viewportY).toBe(13)
    marks.jump(-1)
    expect(term.buffer.active.viewportY).toBe(2)
    // Before the first prompt there is none: the view stays.
    expect(marks.jump(-1)).toBe(true)
    expect(term.buffer.active.viewportY).toBe(2)

    marks.jump(1)
    expect(term.buffer.active.viewportY).toBe(13)
    marks.jump(1)
    expect(term.buffer.active.viewportY).toBe(bottom)
  })
})
