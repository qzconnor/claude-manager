import { describe, expect, it, vi } from 'vitest'
import type { IFunctionIdentifier, Terminal } from '@xterm/xterm'
import { answerColorQueries, x11Color, type ColorSchemeSource } from './color-queries'

describe('x11Color', () => {
  it('doubles each channel of #rrggbb', () => {
    expect(x11Color('#1c1917')).toBe('rgb:1c1c/1919/1717')
  })

  it('expands #rgb first', () => {
    expect(x11Color('#abc')).toBe('rgb:aaaa/bbbb/cccc')
  })

  it('lower-cases and ignores surrounding whitespace', () => {
    expect(x11Color('  #FFA0B0 ')).toBe('rgb:ffff/a0a0/b0b0')
  })

  it('returns null for anything else', () => {
    expect(x11Color('')).toBeNull()
    expect(x11Color('red')).toBeNull()
    expect(x11Color('1c1917')).toBeNull()
    expect(x11Color('#12345')).toBeNull()
    expect(x11Color('#1c191780')).toBeNull()
    expect(x11Color('rgba(0, 0, 0, 0.5)')).toBeNull()
  })
})

type OscHandler = (data: string) => boolean | Promise<boolean>
type CsiHandler = (params: (number | number[])[]) => boolean | Promise<boolean>

/** Just enough of xterm's Terminal: handlers are collected, replies recorded. */
function fakeTerminal() {
  const osc = new Map<number, OscHandler>()
  const csi: { id: IFunctionIdentifier; handler: CsiHandler }[] = []
  const dispose = vi.fn()
  const term = {
    input: vi.fn(),
    parser: {
      registerOscHandler: (ident: number, handler: OscHandler) => {
        osc.set(ident, handler)
        return { dispose }
      },
      registerCsiHandler: (id: IFunctionIdentifier, handler: CsiHandler) => {
        csi.push({ id, handler })
        return { dispose }
      },
    },
  }
  return { term, osc, csi, dispose, asTerminal: term as unknown as Terminal }
}

describe('answerColorQueries', () => {
  function setup(initial: ColorSchemeSource) {
    const fake = fakeTerminal()
    let source = initial
    const disposables = answerColorQueries(fake.asTerminal, () => source)
    const background = fake.osc.get(11)!
    const scheme = fake.csi.find((c) => c.id.prefix === '?' && c.id.final === 'n')!.handler
    return { ...fake, disposables, background, scheme, setSource: (next: ColorSchemeSource) => (source = next) }
  }

  it('registers one OSC 11 and one CSI ? n handler and returns both disposables', () => {
    const { osc, csi, disposables, dispose } = setup({ background: '#1c1917', dark: true })
    expect([...osc.keys()]).toEqual([11])
    expect(csi.map((c) => c.id)).toEqual([{ prefix: '?', final: 'n' }])
    expect(disposables).toHaveLength(2)
    disposables.forEach((d) => d.dispose())
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('answers the background query with the theme background', () => {
    const { term, background } = setup({ background: '#1c1917', dark: true })
    expect(background('?')).toBe(true)
    expect(term.input).toHaveBeenCalledWith('\x1b]11;rgb:1c1c/1919/1717\x1b\\', false)
  })

  it('leaves setting the background to xterm', () => {
    const { term, background } = setup({ background: '#1c1917', dark: true })
    expect(background('rgb:0000/0000/0000')).toBe(false)
    expect(term.input).not.toHaveBeenCalled()
  })

  it('leaves the query to xterm when the background is not a hex color', () => {
    const { term, background } = setup({ background: 'transparent', dark: true })
    expect(background('?')).toBe(false)
    expect(term.input).not.toHaveBeenCalled()
  })

  it('answers CSI ? 996 n with dark or light', () => {
    const { term, scheme, setSource } = setup({ background: '#1c1917', dark: true })
    expect(scheme([996])).toBe(true)
    expect(term.input).toHaveBeenLastCalledWith('\x1b[?997;1n', false)
    setSource({ background: '#ffffff', dark: false })
    expect(scheme([996])).toBe(true)
    expect(term.input).toHaveBeenLastCalledWith('\x1b[?997;2n', false)
  })

  it('reads the colors at query time, so a theme change is answered right away', () => {
    const { term, background, setSource } = setup({ background: '#1c1917', dark: true })
    setSource({ background: '#fff', dark: false })
    background('?')
    expect(term.input).toHaveBeenCalledWith('\x1b]11;rgb:ffff/ffff/ffff\x1b\\', false)
  })

  it('leaves other device status reports to xterm', () => {
    const { term, scheme } = setup({ background: '#1c1917', dark: true })
    expect(scheme([6])).toBe(false)
    expect(scheme([996, 1])).toBe(false)
    expect(scheme([])).toBe(false)
    expect(scheme([[996]])).toBe(false)
    expect(term.input).not.toHaveBeenCalled()
  })
})
