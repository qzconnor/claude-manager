import { describe, expect, it } from 'vitest'
import type { PaneNode, PaneSplit, TerminalInfo } from '@shared/types'
import { groupTabs } from './tabs'

const terminal = (id: string) => ({ id }) as TerminalInfo
const row = (first: PaneNode, second: PaneNode): PaneSplit => ({ direction: 'row', ratio: 0.5, first, second })
const ids = (tabs: ReturnType<typeof groupTabs>) => tabs.map((tab) => [tab.id, tab.panes.map((p) => p.id)])

describe('groupTabs', () => {
  it('gives every terminal a tab of its own without layouts', () => {
    expect(ids(groupTabs(['a', 'b'].map(terminal), []))).toEqual([
      ['a', ['a']],
      ['b', ['b']],
    ])
  })

  it('puts a split tab where the first of its terminals is in the order', () => {
    const tabs = groupTabs(['x', 'c', 'a', 'b'].map(terminal), [row('a', row('b', 'c'))])
    expect(ids(tabs)).toEqual([
      ['x', ['x']],
      ['a', ['a', 'b', 'c']],
    ])
    expect(tabs[1].layout).toEqual(row('a', row('b', 'c')))
  })

  it('leaves out parts whose terminal is not open, and terminals named twice', () => {
    const tabs = groupTabs(['a', 'b', 'c'].map(terminal), [row('a', row('gone', 'b')), row('b', 'c')])
    expect(ids(tabs)).toEqual([
      ['a', ['a', 'b']],
      ['c', ['c']],
    ])
    expect(tabs[0].layout).toEqual(row('a', 'b'))
  })

  it('gives a terminal left alone in a layout its own tab', () => {
    expect(ids(groupTabs(['a'].map(terminal), [row('a', 'gone')]))).toEqual([['a', ['a']]])
  })
})
