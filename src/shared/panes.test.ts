import { describe, expect, it } from 'vitest'
import {
  dropPanes,
  hasPane,
  insertPane,
  layoutPanes,
  neighbourPane,
  ownerOf,
  paneIds,
  parsePaneNode,
  removePanes,
  replacePane,
  setRatio,
  splitPane,
} from './panes'
import type { PaneNode, PaneSplit } from './types'

const row = (first: PaneNode, second: PaneNode, ratio = 0.5): PaneSplit => ({ direction: 'row', ratio, first, second })
const column = (first: PaneNode, second: PaneNode, ratio = 0.5): PaneSplit => ({ direction: 'column', ratio, first, second })

// a | b
//   | -
//   | c
const tree = row('a', column('b', 'c'))

describe('splitPane', () => {
  it('splits a single terminal in half, the new one to the right or below', () => {
    expect(splitPane('a', 'a', 'b', 'row')).toEqual(row('a', 'b'))
    expect(splitPane('a', 'a', 'b', 'column')).toEqual(column('a', 'b'))
  })

  it('splits only the part of the terminal, wherever it lies', () => {
    expect(splitPane(tree, 'c', 'd', 'row')).toEqual(row('a', column('b', row('c', 'd'))))
    expect(splitPane(tree, 'x', 'd', 'row')).toEqual(tree)
  })
})

describe('insertPane', () => {
  it('puts a terminal on each side of a part', () => {
    expect(insertPane('a', 'a', 'b', 'right')).toEqual(row('a', 'b'))
    expect(insertPane('a', 'a', 'b', 'left')).toEqual(row('b', 'a'))
    expect(insertPane('a', 'a', 'b', 'down')).toEqual(column('a', 'b'))
    expect(insertPane('a', 'a', 'b', 'up')).toEqual(column('b', 'a'))
  })

  it('takes a whole tab into the part, wherever it lies', () => {
    expect(insertPane(tree, 'c', row('d', 'e'), 'left')).toEqual(row('a', column('b', row(row('d', 'e'), 'c'))))
  })

  it('leaves the tree alone without the part', () => {
    expect(insertPane(tree, 'x', 'd', 'right')).toBe(tree)
  })
})

describe('removePanes', () => {
  it('gives the space of a removed terminal to the other part', () => {
    expect(removePanes(tree, new Set(['b']))).toEqual(row('a', 'c'))
    expect(removePanes(tree, new Set(['a']))).toEqual(column('b', 'c'))
    expect(removePanes(tree, new Set(['b', 'c']))).toBe('a')
  })

  it('is null once nothing is left, and the same tree when nothing was removed', () => {
    expect(removePanes(tree, new Set(['a', 'b', 'c']))).toBeNull()
    expect(removePanes(tree, new Set(['x']))).toBe(tree)
  })

  it('drops the tabs that are left with one terminal', () => {
    expect(dropPanes([tree, row('x', 'y')], new Set(['x', 'c']))).toEqual([row('a', 'b')])
  })
})

describe('replacePane, setRatio and paneIds', () => {
  it('puts a terminal in the place of another', () => {
    expect(replacePane(tree, 'b', 'n')).toEqual(row('a', column('n', 'c')))
  })

  it('resizes the split at the path and clamps the share', () => {
    expect(setRatio(tree, ['second'], 0.3)).toEqual(row('a', column('b', 'c', 0.3)))
    expect(setRatio(tree, [], 2)).toEqual(row('a', column('b', 'c'), 0.95))
    expect(setRatio(tree, ['first'], 0.3)).toEqual(tree)
  })

  it('lists the terminals from left to right and top to bottom', () => {
    expect(paneIds(tree)).toEqual(['a', 'b', 'c'])
    expect(hasPane(tree, 'c')).toBe(true)
    expect(hasPane(tree, 'x')).toBe(false)
  })
})

describe('ownerOf', () => {
  const session = (id: string) => id.startsWith('s')

  it('finds the session a browser was opened beside', () => {
    expect(ownerOf(row('s1', 'b1'), 'b1', session)).toBe('s1')
    // A second browser below the first one belongs to the same session.
    expect(ownerOf(row('s1', column('b1', 'b2')), 'b2', session)).toBe('s1')
    // Two sessions side by side, the browser beside both: the one that was split.
    expect(ownerOf(row(row('s1', 's2'), 'b1'), 'b1', session)).toBe('s1')
    expect(ownerOf(row('s1', row('s2', 'b2')), 'b2', session)).toBe('s2')
  })

  it('finds none for a browser on its own or a pane that is not there', () => {
    expect(ownerOf('b1', 'b1', session)).toBeNull()
    expect(ownerOf(row('b1', 'b2'), 'b2', session)).toBeNull()
    expect(ownerOf(row('s1', 'b1'), 'x', session)).toBeNull()
  })
})

describe('parsePaneNode', () => {
  it('takes valid trees and clamps their shares', () => {
    expect(parsePaneNode(tree)).toEqual(tree)
    expect(parsePaneNode({ ...row('a', 'b'), ratio: -1, extra: true })).toEqual(row('a', 'b', 0.05))
  })

  it('refuses broken trees and terminals that come twice', () => {
    for (const value of [null, '', 1, row('a', 'a'), { ...row('a', 'b'), direction: 'diagonal' }, row('a', 2 as never), { ...row('a', 'b'), ratio: Number.NaN }]) {
      expect(parsePaneNode(value)).toBeNull()
    }
  })

  it('refuses trees deeper than anybody splits', () => {
    let deep: PaneNode = 't0'
    for (let i = 1; i <= 20; i++) deep = row(deep, `t${i}`)
    expect(parsePaneNode(deep)).toBeNull()
  })
})

describe('layoutPanes', () => {
  it('shares out the space by the ratios', () => {
    const { panes, dividers } = layoutPanes(row('a', column('b', 'c', 0.25), 0.6))
    expect(panes.get('a')).toEqual({ left: 0, top: 0, width: 0.6, height: 1 })
    expect(panes.get('b')!.top).toBe(0)
    expect(panes.get('b')!.height).toBeCloseTo(0.25)
    expect(panes.get('c')!.left).toBeCloseTo(0.6)
    expect(panes.get('c')!.width).toBeCloseTo(0.4)
    expect(panes.get('c')!.top).toBeCloseTo(0.25)
    expect(dividers.map((d) => [d.path, d.direction, d.ratio])).toEqual([
      [[], 'row', 0.6],
      [['second'], 'column', 0.25],
    ])
  })

  it('gives a single terminal the whole tab', () => {
    expect(layoutPanes('a')).toEqual({ panes: new Map([['a', { left: 0, top: 0, width: 1, height: 1 }]]), dividers: [] })
  })
})

describe('neighbourPane', () => {
  it('finds the terminal across an edge', () => {
    expect(neighbourPane(tree, 'a', 'right')).toBe('b')
    expect(neighbourPane(tree, 'c', 'left')).toBe('a')
    expect(neighbourPane(tree, 'b', 'down')).toBe('c')
    expect(neighbourPane(tree, 'c', 'up')).toBe('b')
  })

  it('is null at the edge of the tab', () => {
    expect(neighbourPane(tree, 'a', 'left')).toBeNull()
    expect(neighbourPane(tree, 'a', 'up')).toBeNull()
    expect(neighbourPane(tree, 'x', 'up')).toBeNull()
  })

  it('prefers the terminal beside the middle of the edge', () => {
    // a | b (upper 70 %)
    //   | c
    const tall = row('a', column('b', 'c', 0.7))
    expect(neighbourPane(tall, 'a', 'right')).toBe('b')
    const short = row('a', column('b', 'c', 0.3))
    expect(neighbourPane(short, 'a', 'right')).toBe('c')
  })
})
