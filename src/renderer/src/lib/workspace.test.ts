import { describe, expect, it } from 'vitest'
import { MAX_SPLIT_DEPTH } from '@shared/panes'
import {
  addTab,
  allTabs,
  createWorkspace,
  diffOfTab,
  diffTab,
  dockTab,
  groupDropSpot,
  isViewTab,
  mapTabs,
  moveTab,
  pageOfTab,
  pageTab,
  parseWorkspace,
  removeTab,
  replaceTab,
  showTab,
  splitGroup,
  type Workspace,
} from './workspace'

const two = (): Workspace => splitGroup(createWorkspace('g1', ['a', 'b']), 'g1', 'right', 'g2', ['c'])

describe('workspace', () => {
  it('adds a tab after the shown one, and shows it only when asked', () => {
    const ws = addTab(createWorkspace('g1', ['a', 'b']), 'g1', 'x')
    expect(ws.groups[0]).toEqual({ id: 'g1', tabs: ['a', 'x', 'b'], active: 'a' })
    expect(addTab(ws, 'g1', 'y', { activate: true }).groups[0].active).toBe('y')
  })

  it('shows the neighbour of a closed tab and drops a group left empty', () => {
    let ws = two()
    ws = removeTab(ws, 'a')
    expect(ws.groups.find((g) => g.id === 'g1')).toEqual({ id: 'g1', tabs: ['b'], active: 'b' })
    ws = { ...ws, activeGroup: 'g2' }
    ws = removeTab(ws, 'c')
    expect(ws.layout).toBe('g1')
    expect(ws.activeGroup).toBe('g1')
  })

  it('keeps the last group, emptied', () => {
    const ws = removeTab(createWorkspace('g1', ['a']), 'a')
    expect(ws.groups).toEqual([{ id: 'g1', tabs: [], active: null }])
  })

  it('moves a tab into another group and shows it there', () => {
    const ws = moveTab(two(), 'a', 'g2')
    expect(allTabs(ws)).toEqual(['b', 'c', 'a'])
    expect(ws.groups.find((g) => g.id === 'g2')?.active).toBe('a')
    expect(ws.activeGroup).toBe('g2')
  })

  it('docks a tab into a new group beside another', () => {
    const ws = dockTab(two(), 'b', 'g2', 'down', 'g3')
    expect(ws.layout).toEqual({ direction: 'row', ratio: 0.5, first: 'g1', second: { direction: 'column', ratio: 0.5, first: 'g2', second: 'g3' } })
    expect(ws.activeGroup).toBe('g3')
    // A lone tab can't leave its own group for a group beside it.
    const lone = dockTab(two(), 'c', 'g2', 'down', 'g3')
    expect(lone.layout).toEqual(two().layout)
  })

  it('shows a tab without taking the keyboard', () => {
    const ws = showTab(two(), 'g1', 'b')
    expect(ws.groups.find((g) => g.id === 'g1')?.active).toBe('b')
    expect(ws.activeGroup).toBe('g1')
    expect(showTab({ ...two(), activeGroup: 'g2' }, 'g1', 'b').activeGroup).toBe('g2')
  })

  it('puts a replacing terminal in the old one’s place', () => {
    let ws = addTab(two(), 'g2', 'new')
    ws = replaceTab(ws, 'a', 'new')
    expect(ws.groups.find((g) => g.id === 'g1')).toEqual({ id: 'g1', tabs: ['new', 'b'], active: 'new' })
    expect(ws.groups.find((g) => g.id === 'g2')?.tabs).toEqual(['c'])
  })

  it('maps tabs to new ids and drops the unknown ones', () => {
    const ws = mapTabs(two(), (tab) => (tab === 'c' ? null : `${tab}2`))
    expect(ws.layout).toBe('g1')
    expect(ws.groups).toEqual([{ id: 'g1', tabs: ['a2', 'b2'], active: 'a2' }])
  })

  it('parses only consistent workspaces', () => {
    const ws = addTab(two(), 'g1', pageTab('settings'))
    expect(parseWorkspace(JSON.parse(JSON.stringify(ws)))).toEqual(ws)
    expect(parseWorkspace({ ...ws, groups: ws.groups.slice(1) })).toBeNull()
    expect(pageOfTab(pageTab('settings'))).toBe('settings')
    expect(pageOfTab('page:nope')).toBeNull()
  })

  it('names a file whose changes a tab shows, and reads it back', () => {
    const file = { root: 'C:\Repo "x"', path: 'src/a b.ts' }
    expect(diffOfTab(diffTab(file))).toEqual(file)
    expect(isViewTab(diffTab(file))).toBe(true)
    expect(isViewTab('some-terminal-id')).toBe(false)
    expect(diffOfTab('diff:nope')).toBeNull()
    expect(diffOfTab('diff:["only-root"]')).toBeNull()
    expect(diffOfTab('diff:["", "a.ts"]')).toBeNull()
    // All changes of the folder.
    expect(diffOfTab(diffTab({ root: 'C:\\Repo', path: '' }))).toEqual({ root: 'C:\\Repo', path: '' })
  })

  it('finds the drop spot: bar joins, edges split, middle joins', () => {
    const rects = new Map([['g1', { left: 0, top: 0, width: 400, height: 336 }]])
    expect(groupDropSpot(rects, 200, 10, 36)).toEqual({ groupId: 'g1', side: 'center' })
    expect(groupDropSpot(rects, 380, 200, 36)).toEqual({ groupId: 'g1', side: 'right' })
    expect(groupDropSpot(rects, 200, 330, 36)).toEqual({ groupId: 'g1', side: 'down' })
    expect(groupDropSpot(rects, 200, 186, 36)).toEqual({ groupId: 'g1', side: 'center' })
    expect(groupDropSpot(rects, 500, 186, 36)).toBeNull()
  })
})

describe('a window split as often as it can be', () => {
  /** Groups g0 to g`n`, each split off the last one. */
  const deep = (splits: number): Workspace => {
    let ws = createWorkspace('g0', ['t0'])
    for (let i = 1; i <= splits; i++) ws = splitGroup(ws, `g${i - 1}`, i % 2 ? 'right' : 'down', `g${i}`, [`t${i}`])
    return ws
  }

  it('takes the tabs of a new group into the group instead', () => {
    const ws = deep(MAX_SPLIT_DEPTH)
    expect(parseWorkspace(ws)).not.toBeNull()
    const next = splitGroup(ws, `g${MAX_SPLIT_DEPTH}`, 'right', 'new', ['x'])
    expect(next.layout).toBe(ws.layout)
    expect(next.groups.find((g) => g.id === `g${MAX_SPLIT_DEPTH}`)).toMatchObject({ tabs: [`t${MAX_SPLIT_DEPTH}`, 'x'], active: 'x' })
  })

  it('leaves a tab where it was when dropped on the edge of the deepest group', () => {
    const ws = addTab(deep(MAX_SPLIT_DEPTH), 'g0', 'y')
    expect(dockTab(ws, 'y', `g${MAX_SPLIT_DEPTH}`, 'right', 'new')).toBe(ws)
    expect(dockTab(ws, 'y', 'g1', 'right', 'new').groups.some((g) => g.id === 'new')).toBe(true)
  })
})
