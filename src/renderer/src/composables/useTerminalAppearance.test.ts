import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_FONT_FALLBACKS } from '@shared/defaults'
import { buildFontStack } from './useTerminalAppearance'

// platform.ts reads `window.api` and the store needs Pinia; buildFontStack needs neither.
vi.mock('@/lib/platform', () => ({ supportsMaterial: true }))
vi.mock('@/stores/settings', () => ({ useSettingsStore: vi.fn() }))

const families = (stack: string) => stack.split(', ')

describe('buildFontStack', () => {
  it("puts the user's font first, then the fallbacks, with generic families unquoted", () => {
    const stack = families(buildFontStack('Fira Code'))
    expect(stack[0]).toBe('"Fira Code"')
    expect(stack.slice(1)).toEqual(TERMINAL_FONT_FALLBACKS.map((f) => (f === 'monospace' ? f : `"${f}"`)))
    expect(stack.at(-1)).toBe('monospace')
  })

  it('does not repeat a fallback the user already chose, whatever the case', () => {
    const stack = families(buildFontStack('consolas'))
    expect(stack[0]).toBe('"consolas"')
    expect(stack.filter((f) => f.toLowerCase() === '"consolas"')).toHaveLength(1)
    expect(stack).toHaveLength(TERMINAL_FONT_FALLBACKS.length)
  })

  it('takes a comma separated list with quotes and spaces', () => {
    const stack = families(buildFontStack(` "JetBrains Mono" , 'Fira Code',ui-monospace, `))
    expect(stack.slice(0, 3)).toEqual(['"JetBrains Mono"', '"Fira Code"', 'ui-monospace'])
  })

  it('keeps a generic family the user put in the middle and does not add it again', () => {
    const stack = families(buildFontStack('Hack, monospace'))
    expect(stack.slice(0, 2)).toEqual(['"Hack"', 'monospace'])
    expect(stack.filter((f) => f === 'monospace')).toHaveLength(1)
  })

  it('drops quotes inside a name so the stack stays valid CSS', () => {
    expect(families(buildFontStack('My"Font'))[0]).toBe('"MyFont"')
  })

  it('uses only the fallbacks without a font', () => {
    expect(families(buildFontStack(''))).toHaveLength(TERMINAL_FONT_FALLBACKS.length)
    expect(families(buildFontStack(' , ')).at(0)).toBe(`"${TERMINAL_FONT_FALLBACKS[0]}"`)
  })
})
