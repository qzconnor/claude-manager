import { describe, expect, it } from 'vitest'
import { OVERFLOW_FADE_PX, overflowMask, stripOverflow } from './useOverflowFade'

describe('stripOverflow', () => {
  it('tells on which side tabs are scrolled away', () => {
    expect(stripOverflow(null)).toEqual({ start: false, end: false })
    expect(stripOverflow({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 })).toEqual({ start: false, end: false })
    expect(stripOverflow({ scrollLeft: 0, clientWidth: 300, scrollWidth: 500 })).toEqual({ start: false, end: true })
    expect(stripOverflow({ scrollLeft: 100, clientWidth: 300, scrollWidth: 500 })).toEqual({ start: true, end: true })
    // Rounded scroll positions at the very end count as the end.
    expect(stripOverflow({ scrollLeft: 199.5, clientWidth: 300, scrollWidth: 500 })).toEqual({ start: true, end: false })
  })
})

describe('overflowMask', () => {
  it('fades only the sides with more tabs behind them', () => {
    expect(overflowMask({ start: false, end: false })).toBeUndefined()
    expect(overflowMask({ start: false, end: true })).toEqual({
      maskImage: `linear-gradient(to right, black, black ${OVERFLOW_FADE_PX}px, black calc(100% - ${OVERFLOW_FADE_PX}px), transparent)`,
    })
    expect(overflowMask({ start: true, end: false })?.maskImage).toMatch(/^linear-gradient\(to right, transparent, .*black\)$/)
  })

  it('leaves the line under the tabs whole', () => {
    expect(overflowMask({ start: true, end: true }, 1)).toEqual({
      maskImage: `linear-gradient(to right, transparent, black ${OVERFLOW_FADE_PX}px, black calc(100% - ${OVERFLOW_FADE_PX}px), transparent), linear-gradient(black, black)`,
      maskSize: '100% calc(100% - 1px), 100% 1px',
      maskPosition: 'top, bottom',
      maskRepeat: 'no-repeat',
    })
  })
})
