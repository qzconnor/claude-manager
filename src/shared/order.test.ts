import { describe, expect, it } from 'vitest'
import { applyOrder, moveItem } from './order'

const id = (s: string) => s

describe('applyOrder', () => {
  it('sorts the items like the ids', () => {
    expect(applyOrder(['a', 'b', 'c'], ['c', 'a', 'b'], id)).toEqual(['c', 'a', 'b'])
  })

  it('keeps items without an id in the order at the end, in their own order', () => {
    expect(applyOrder(['a', 'b', 'c', 'd'], ['c', 'a'], id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('ignores unknown and repeated ids', () => {
    expect(applyOrder(['a', 'b'], ['x', 'b', 'b', 'a', 'y'], id)).toEqual(['b', 'a'])
  })

  it('works with objects and an empty order', () => {
    const items = [{ id: '1' }, { id: '2' }]
    expect(applyOrder(items, [], (t) => t.id)).toEqual(items)
    expect(applyOrder(items, ['2'], (t) => t.id)).toEqual([items[1], items[0]])
  })
})

describe('moveItem', () => {
  it('moves an item forwards and backwards', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('clamps the target and returns a copy', () => {
    const items = ['a', 'b', 'c']
    expect(moveItem(items, 0, 99)).toEqual(['b', 'c', 'a'])
    expect(moveItem(items, 2, -5)).toEqual(['c', 'a', 'b'])
    expect(moveItem(items, 1, 1)).not.toBe(items)
  })

  it('leaves the list as it is for an index out of range', () => {
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b'])
  })
})
