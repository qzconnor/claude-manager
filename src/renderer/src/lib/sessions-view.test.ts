import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SESSIONS_VIEW, parseSessionsView, readSessionsView, saveSessionsView, SESSIONS_VIEW_KEY } from './sessions-view'

const choices = { sorts: ['recent', 'name', 'size', 'count'], ages: ['within-7', 'older-30'], sizes: ['over-1m'] }

afterEach(() => vi.unstubAllGlobals())

describe('parseSessionsView', () => {
  it('gives back what was kept', () => {
    const view = { sort: 'size', account: 'acc-1', age: 'older-30', size: 'over-1m', showStandard: true }
    expect(parseSessionsView(JSON.stringify(view), choices)).toEqual(view)
  })

  it('starts as always without anything kept, or with something broken', () => {
    expect(parseSessionsView(null, choices)).toEqual(DEFAULT_SESSIONS_VIEW)
    expect(parseSessionsView('{', choices)).toEqual(DEFAULT_SESSIONS_VIEW)
    expect(parseSessionsView('"recent"', choices)).toEqual(DEFAULT_SESSIONS_VIEW)
  })

  it('leaves what it doesn’t know at its default, the rest as kept', () => {
    const raw = JSON.stringify({ sort: 'color', account: '', age: 'older-5', size: 'over-1m', showStandard: 'yes' })
    expect(parseSessionsView(raw, choices)).toEqual({ ...DEFAULT_SESSIONS_VIEW, size: 'over-1m' })
  })
})

describe('readSessionsView and saveSessionsView', () => {
  it('keep the view in localStorage', () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    })
    const view = { sort: 'name' as const, account: 'all', age: 'within-7', size: 'all', showStandard: false }
    saveSessionsView(view)
    expect(JSON.parse(storage.get(SESSIONS_VIEW_KEY)!)).toEqual(view)
    expect(readSessionsView(choices)).toEqual(view)
  })

  it('work without storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('full')
      },
    })
    expect(() => saveSessionsView(DEFAULT_SESSIONS_VIEW)).not.toThrow()
    expect(readSessionsView(choices)).toEqual(DEFAULT_SESSIONS_VIEW)
  })
})
