import { describe, expect, it, vi } from 'vitest'
import { findTheme } from '@/themes/themes'
import {
  backgroundReplacements,
  createBackgroundFilter,
  parseHex,
  SLOT_NAMES,
  SLOTS,
  slotPalette,
  themeSlotTints,
  type SlotTints,
} from './claude-backgrounds'

const ESC = '\x1b'
const sgr = (params: string) => `${ESC}[${params}m`

describe('parseHex', () => {
  it('reads #rrggbb and #rgb, in any case', () => {
    expect(parseHex('#ff8000')).toEqual([255, 128, 0])
    expect(parseHex('#FF8000')).toEqual([255, 128, 0])
    expect(parseHex('#f80')).toEqual([255, 136, 0])
    expect(parseHex(' #000 ')).toEqual([0, 0, 0])
  })

  it('returns null for anything else', () => {
    expect(parseHex('ff8000')).toBeNull()
    expect(parseHex('#ff80')).toBeNull()
    expect(parseHex('#ff800080')).toBeNull()
    expect(parseHex('#ggg')).toBeNull()
    expect(parseHex('rgba(255, 128, 0, 0.5)')).toBeNull()
  })
})

describe('themeSlotTints', () => {
  const palette = findTheme('ember').terminal

  it('tints panels with the text color and diffs with green and red', () => {
    const tints = themeSlotTints(palette)
    expect(tints.panel.color).toBe(palette.foreground)
    for (const slot of ['added', 'addedWord', 'addedDimmed'] as const) expect(tints[slot].color).toBe(palette.green)
    for (const slot of ['removed', 'removedWord', 'removedDimmed'] as const) expect(tints[slot].color).toBe(palette.red)
  })

  it('covers every slot with a see-through alpha, words stronger than lines', () => {
    const tints = themeSlotTints(palette)
    expect(Object.keys(tints).sort()).toEqual([...SLOT_NAMES].sort())
    for (const slot of SLOT_NAMES) {
      expect(tints[slot].alpha).toBeGreaterThan(0)
      expect(tints[slot].alpha).toBeLessThan(1)
    }
    expect(tints.addedWord.alpha).toBeGreaterThan(tints.added.alpha)
    expect(tints.removedWord.alpha).toBeGreaterThan(tints.removed.alpha)
  })
})

describe('slotPalette', () => {
  const tints = (color: string, alpha: number): SlotTints =>
    Object.fromEntries(SLOT_NAMES.map((slot) => [slot, { color, alpha }])) as SlotTints

  it('puts each slot at its index above the 16 standard colors', () => {
    const custom = { ...tints('#000000', 0), added: { color: '#ffffff', alpha: 1 } }
    const extended = slotPalette(custom, '#000000')
    expect(extended).toHaveLength(SLOT_NAMES.length)
    expect(extended[SLOTS.added - 16]).toBe('#ffffff')
    expect(extended[SLOTS.panel - 16]).toBe('#000000')
  })

  it('mixes the tint over the background as an opaque color', () => {
    expect(slotPalette(tints('#ffffff', 0.5), '#000000')[0]).toBe('#808080')
    expect(slotPalette(tints('#ff0000', 0.25), '#0000ff')[0]).toBe('#4000bf')
    expect(slotPalette(tints('#fff', 0), '#123456')[0]).toBe('#123456')
  })

  it('falls back to the tint color when a color is not hex', () => {
    expect(slotPalette(tints('#ffffff', 0.5), 'transparent')[0]).toBe('#ffffff')
    expect(slotPalette(tints('rgb(1, 2, 3)', 0.5), '#000000')[0]).toBe('rgb(1, 2, 3)')
  })
})

describe('backgroundReplacements', () => {
  const panelSgr = `48;5;${SLOTS.panel}`

  it('maps panels and diffs to their slots with the theme', () => {
    const map = backgroundReplacements('theme', 'theme')
    // Claude's dark panel and the syntax highlighted diff of its dark theme.
    expect(map.get('38;38;38')).toBe(panelSgr)
    expect(map.get('2;40;0')).toBe(`48;5;${SLOTS.added}`)
    expect(map.get('4;71;0')).toBe(`48;5;${SLOTS.addedWord}`)
    expect(map.get('61;1;0')).toBe(`48;5;${SLOTS.removed}`)
    expect(map.get('92;2;0')).toBe(`48;5;${SLOTS.removedWord}`)
    expect(new Set(map.values())).toEqual(new Set(SLOT_NAMES.map((slot) => `48;5;${SLOTS[slot]}`)))
  })

  it("maps panels to the terminal's own background", () => {
    const map = backgroundReplacements('terminal', 'original')
    expect(map.get('38;38;38')).toBe('49')
    expect(new Set(map.values())).toEqual(new Set(['49']))
  })

  it('leaves the original colors alone', () => {
    expect(backgroundReplacements('original', 'original').size).toBe(0)
    const diffOnly = backgroundReplacements('original', 'theme')
    expect(diffOnly.has('38;38;38')).toBe(false)
    expect(diffOnly.get('2;40;0')).toBe(`48;5;${SLOTS.added}`)
  })

  it('has disjoint panel and diff colors', () => {
    const panel = backgroundReplacements('theme', 'original')
    const diff = backgroundReplacements('original', 'theme')
    expect(backgroundReplacements('theme', 'theme').size).toBe(panel.size + diff.size)
  })
})

describe('createBackgroundFilter', () => {
  const themed = () => backgroundReplacements('theme', 'theme')

  it('passes output without colors through unchanged', () => {
    const filter = createBackgroundFilter(themed)
    const text = `hello ${sgr('1;31')}world${sgr('0')}\r\n${ESC}]0;title\x07`
    expect(filter(text)).toBe(text)
  })

  it("exchanges Claude's backgrounds for slots", () => {
    const filter = createBackgroundFilter(themed)
    expect(filter(`a${sgr('48;2;38;38;38')}b${sgr('49')}`)).toBe(`a${sgr('48;5;16')}b${sgr('49')}`)
    expect(filter(sgr('48;2;61;1;0'))).toBe(sgr('48;5;20'))
  })

  it('keeps the other parameters of the sequence', () => {
    const filter = createBackgroundFilter(themed)
    expect(filter(sgr('1;38;2;38;38;38;48;2;38;38;38;4'))).toBe(sgr('1;38;2;38;38;38;48;5;16;4'))
  })

  it('leaves foregrounds and unknown backgrounds alone', () => {
    const filter = createBackgroundFilter(themed)
    expect(filter(sgr('38;2;38;38;38'))).toBe(sgr('38;2;38;38;38'))
    expect(filter(sgr('48;2;1;2;3'))).toBe(sgr('48;2;1;2;3'))
    expect(filter(sgr('58;2;38;38;38'))).toBe(sgr('58;2;38;38;38'))
  })

  it("gives programs that use a slot themselves the slot's standard color", () => {
    const filter = createBackgroundFilter(themed)
    expect(filter(sgr('48;5;16'))).toBe(sgr('48;2;0;0;0'))
    expect(filter(sgr('38;5;17'))).toBe(sgr('38;2;0;0;95'))
    expect(filter(sgr('1;38;5;22;48;5;20'))).toBe(sgr('1;38;2;0;95;0;48;2;0;0;215'))
    expect(filter(sgr('48:5:21'))).toBe(sgr('48;2;0;0;255'))
  })

  it('leaves other palette colors alone', () => {
    const filter = createBackgroundFilter(themed)
    for (const params of ['38;5;160', '48;5;23', '38;5;15', '5;16', '38:5:160']) expect(filter(sgr(params))).toBe(sgr(params))
  })

  it('holds back a sequence cut off at the end of a chunk', () => {
    const filter = createBackgroundFilter(themed)
    expect(filter(`abc${ESC}[48;2;38;3`)).toBe('abc')
    expect(filter(`8;38mdef`)).toBe(`${sgr('48;5;16')}def`)
    expect(filter(`x${ESC}`)).toBe('x')
    expect(filter('[0m')).toBe(sgr('0'))
  })

  it('asks for the replacements on every chunk, so a settings change applies right away', () => {
    let current = themed()
    const replacements = vi.fn(() => current)
    const filter = createBackgroundFilter(replacements)
    expect(filter('plain')).toBe('plain')
    expect(replacements).not.toHaveBeenCalled()
    expect(filter(sgr('48;2;38;38;38'))).toBe(sgr('48;5;16'))
    current = backgroundReplacements('terminal', 'original')
    expect(filter(sgr('48;2;38;38;38'))).toBe(sgr('49'))
    current = backgroundReplacements('original', 'original')
    expect(filter(sgr('48;2;38;38;38'))).toBe(sgr('48;2;38;38;38'))
  })

  it('still frees the slots when nothing is exchanged', () => {
    const filter = createBackgroundFilter(() => backgroundReplacements('original', 'original'))
    expect(filter(sgr('48;5;16'))).toBe(sgr('48;2;0;0;0'))
  })
})
