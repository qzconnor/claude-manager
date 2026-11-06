import { describe, expect, it } from 'vitest'
import { pointerMoveMs } from './pointer'

describe('pointerMoveMs', () => {
  it('appears at once without an earlier spot', () => {
    expect(pointerMoveMs(null, { x: 500, y: 300 })).toBe(0)
  })

  it('stays put on the same spot', () => {
    expect(pointerMoveMs({ x: 10, y: 10 }, { x: 11, y: 10 })).toBe(0)
  })

  it('takes longer for longer ways', () => {
    const short = pointerMoveMs({ x: 0, y: 0 }, { x: 30, y: 40 })
    const long = pointerMoveMs({ x: 0, y: 0 }, { x: 300, y: 400 })
    expect(short).toBe(168)
    expect(long).toBe(325)
  })

  it('never takes long', () => {
    expect(pointerMoveMs({ x: 0, y: 0 }, { x: 3000, y: 2000 })).toBe(450)
  })
})
