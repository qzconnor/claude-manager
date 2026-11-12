import { describe, expect, it } from 'vitest'
import { listMove } from './list-keys'

const row = (index: number, expanded: boolean | null = null, parent = -1) => ({ index, count: 5, expanded, parent })

describe('listMove', () => {
  it('goes up and down and stops at the ends', () => {
    expect(listMove('ArrowDown', row(1))).toEqual({ to: 2 })
    expect(listMove('ArrowDown', row(4))).toEqual({ to: 4 })
    expect(listMove('ArrowUp', row(1))).toEqual({ to: 0 })
    expect(listMove('ArrowUp', row(0))).toEqual({ to: 0 })
  })

  it('jumps to the first and the last row', () => {
    expect(listMove('Home', row(3))).toEqual({ to: 0 })
    expect(listMove('End', row(1))).toEqual({ to: 4 })
  })

  it('opens a closed group with Right and goes into an open one', () => {
    expect(listMove('ArrowRight', row(1, false))).toEqual({ toggle: true })
    expect(listMove('ArrowRight', row(1, true))).toEqual({ to: 2 })
    expect(listMove('ArrowRight', row(4, true))).toBeNull()
    expect(listMove('ArrowRight', row(2))).toBeNull()
  })

  it('closes an open group with Left, otherwise goes up to the group around', () => {
    expect(listMove('ArrowLeft', row(3, true, 1))).toEqual({ toggle: true })
    expect(listMove('ArrowLeft', row(3, false, 1))).toEqual({ to: 1 })
    expect(listMove('ArrowLeft', row(3, null, 1))).toEqual({ to: 1 })
    expect(listMove('ArrowLeft', row(0, false))).toBeNull()
  })

  it('leaves other keys and an empty list alone', () => {
    expect(listMove('a', row(1))).toBeNull()
    expect(listMove('ArrowDown', { index: 0, count: 0, expanded: null, parent: -1 })).toBeNull()
    expect(listMove('ArrowDown', { index: -1, count: 3, expanded: null, parent: -1 })).toBeNull()
  })
})
