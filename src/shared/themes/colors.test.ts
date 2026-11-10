import { describe, expect, it } from 'vitest'
import { contrastRatio, formatColor, hsvToRgb, isLight, normalizeColor, parseColor, rgbToHsv, toHex } from './colors'

describe('parseColor', () => {
  it('reads hex in every length', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('#D97757')).toEqual({ r: 217, g: 119, b: 87, a: 1 })
    expect(parseColor('#00000080')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 })
    expect(parseColor('#0008')).toEqual({ r: 0, g: 0, b: 0, a: 0.53 })
  })

  it('reads rgb and rgba', () => {
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 })
    expect(parseColor('rgba(217, 119, 87, 0.32)')).toEqual({ r: 217, g: 119, b: 87, a: 0.32 })
    expect(parseColor(' rgba(0,0,0,.5) ')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 })
  })

  it('refuses what is no color', () => {
    for (const value of ['', 'red', '#ff', '#fffff', '#ggg', 'rgb(256, 0, 0)', 'rgba(0, 0, 0, 2)', 'hsl(0 0% 0%)']) {
      expect(parseColor(value), value).toBeNull()
    }
  })
})

describe('formatColor', () => {
  it('writes opaque colors as hex and see-through ones as rgba', () => {
    expect(formatColor({ r: 217, g: 119, b: 87, a: 1 })).toBe('#d97757')
    expect(formatColor({ r: 217, g: 119, b: 87, a: 0.321 })).toBe('rgba(217, 119, 87, 0.32)')
  })

  it('normalizes', () => {
    expect(normalizeColor('#ABC')).toBe('#aabbcc')
    expect(normalizeColor('rgb(9, 105, 218)')).toBe('#0969da')
    expect(normalizeColor('#09f0')).toBe('rgba(0, 153, 255, 0)')
    expect(normalizeColor('nope')).toBeNull()
  })
})

describe('hsv', () => {
  it('goes there and back', () => {
    for (const hex of ['#d97757', '#000000', '#ffffff', '#7fa8e8', '#9fcf7a', '#808080']) {
      const color = parseColor(hex)!
      expect(toHex(hsvToRgb(rgbToHsv(color))), hex).toBe(hex)
    }
  })

  it('knows the primary hues', () => {
    expect(rgbToHsv(parseColor('#ff0000')!)).toEqual({ h: 0, s: 1, v: 1 })
    expect(rgbToHsv(parseColor('#00ff00')!).h).toBe(120)
    expect(rgbToHsv(parseColor('#0000ff')!).h).toBe(240)
    expect(toHex(hsvToRgb({ h: 60, s: 1, v: 1 }))).toBe('#ffff00')
  })
})

describe('contrast', () => {
  it('is 21 for black on white and 1 for the same color', () => {
    expect(contrastRatio(parseColor('#000')!, parseColor('#fff')!)).toBeCloseTo(21)
    expect(contrastRatio(parseColor('#d97757')!, parseColor('#d97757')!)).toBe(1)
  })

  it('tells light from dark', () => {
    expect(isLight(parseColor('#f6f6f7')!)).toBe(true)
    expect(isLight(parseColor('#1c1917')!)).toBe(false)
  })
})
