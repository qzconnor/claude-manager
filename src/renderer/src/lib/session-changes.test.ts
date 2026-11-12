import { describe, expect, it } from 'vitest'
import type { SessionFileChange } from '@shared/types'
import { changePath, changeTotals, noteLabel } from './session-changes'

describe('changePath', () => {
  it('shows a file of the session folder relative to it, Windows without case', () => {
    expect(changePath('F:\\Projekte\\app\\src\\a.ts', 'F:\\Projekte\\app')).toEqual({ name: 'a.ts', dir: 'src' })
    expect(changePath('f:\\projekte\\APP\\a.ts', 'F:\\Projekte\\app\\')).toEqual({ name: 'a.ts', dir: '' })
    expect(changePath('/home/dev/app/src/lib/a.ts', '/home/dev/app')).toEqual({ name: 'a.ts', dir: 'src/lib' })
    // Only the folder itself, not one starting the same.
    expect(changePath('/home/dev/app2/a.ts', '/home/dev/app', '/home/dev')).toEqual({ name: 'a.ts', dir: '~/app2' })
    expect(changePath('/home/dev/App/a.ts', '/home/dev/app')).toEqual({ name: 'a.ts', dir: '/home/dev/App' })
  })

  it('shows one elsewhere from the home folder, or as it is', () => {
    expect(changePath('C:\\Users\\me\\notes\\x.md', 'F:\\app', 'C:\\Users\\me')).toEqual({ name: 'x.md', dir: '~\\notes' })
    expect(changePath('/tmp/x.md', null)).toEqual({ name: 'x.md', dir: '/tmp' })
  })
})

describe('changeTotals', () => {
  const change = (added: number | null, removed: number | null): SessionFileChange => ({
    path: '/a',
    kind: 'modified',
    added,
    removed,
    note: added === null ? 'binary' : null,
  })

  it('adds up the lines, and says when some couldn’t be counted', () => {
    expect(changeTotals([])).toEqual({ added: 0, removed: 0, unknown: false })
    expect(changeTotals([change(3, 1), change(2, 0)])).toEqual({ added: 5, removed: 1, unknown: false })
    expect(changeTotals([change(3, 1), change(null, null)])).toEqual({ added: 3, removed: 1, unknown: true })
    expect(changeTotals([change(1, null)])).toEqual({ added: 0, removed: 0, unknown: true })
  })
})

describe('noteLabel', () => {
  it('names why lines aren’t counted', () => {
    expect([noteLabel('binary'), noteLabel('tooLarge'), noteLabel('unavailable')]).toEqual(['Binärdatei', 'zu groß', 'Stand nicht mehr da'])
  })
})
