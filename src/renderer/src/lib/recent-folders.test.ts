import { describe, expect, it } from 'vitest'
import { folderKey, recentFolders, splitFolder } from './recent-folders'

describe('folderKey', () => {
  it('compares Windows paths without regard to case, slash and trailing separator', () => {
    expect(folderKey('F:\\Code\\App\\')).toBe('f:\\code\\app')
    expect(folderKey('f:/code/app')).toBe('f:\\code\\app')
    expect(folderKey('\\\\Server\\Share\\')).toBe('\\\\server\\share')
  })

  it('keeps the case of other paths', () => {
    expect(folderKey('/home/me/Code/')).toBe('/home/me/Code')
    expect(folderKey('/home/me/code')).not.toBe(folderKey('/home/me/Code'))
  })

  it('keeps the separator of a root', () => {
    expect(folderKey('C:\\')).toBe('c:\\')
    expect(folderKey('/')).toBe('/')
  })
})

describe('splitFolder', () => {
  it('splits name and parent', () => {
    expect(splitFolder('F:\\Projekte\\Apps\\claude-manager')).toEqual({
      name: 'claude-manager',
      parent: 'F:\\Projekte\\Apps',
    })
    expect(splitFolder('/home/me/code/')).toEqual({ name: 'code', parent: '/home/me' })
  })

  it('keeps the separator of a parent that is a root', () => {
    expect(splitFolder('C:\\Code')).toEqual({ name: 'Code', parent: 'C:\\' })
    expect(splitFolder('/srv')).toEqual({ name: 'srv', parent: '/' })
  })

  it('names a root after itself', () => {
    expect(splitFolder('C:\\')).toEqual({ name: 'C:\\', parent: '' })
    expect(splitFolder('/')).toEqual({ name: '/', parent: '' })
  })
})

describe('recentFolders', () => {
  const uses = [
    { path: 'F:\\Code\\app', at: '2026-11-01T10:00:00.000Z' },
    { path: 'F:\\Code\\web', at: '2026-11-03T10:00:00.000Z' },
    { path: 'f:\\code\\APP\\', at: '2026-11-05T10:00:00.000Z' },
    { path: 'C:\\Users\\me\\Downloads', at: '2026-11-06T10:00:00.000Z' },
    { path: 'F:\\Code\\notes', at: '2026-10-01T10:00:00.000Z' },
  ]

  it('lists each folder once, latest use first, as written in that use', () => {
    expect(recentFolders(uses, { limit: 10 }).map((f) => [f.path, f.lastUsed])).toEqual([
      ['C:\\Users\\me\\Downloads', '2026-11-06T10:00:00.000Z'],
      ['f:\\code\\APP', '2026-11-05T10:00:00.000Z'],
      ['F:\\Code\\web', '2026-11-03T10:00:00.000Z'],
      ['F:\\Code\\notes', '2026-10-01T10:00:00.000Z'],
    ])
  })

  it('leaves out the excluded folders and empty paths', () => {
    const list = recentFolders([...uses, { path: '  ', at: '2026-11-07T00:00:00.000Z' }], {
      limit: 10,
      exclude: ['c:/users/me/downloads/', null, '', undefined],
    })
    expect(list.map((f) => f.name)).toEqual(['APP', 'web', 'notes'])
  })

  it('stops at the limit', () => {
    expect(recentFolders(uses, { limit: 2 }).map((f) => f.name)).toEqual(['Downloads', 'APP'])
    expect(recentFolders(uses, { limit: 0 })).toEqual([])
  })

  it('names the parent folder', () => {
    const [folder] = recentFolders([{ path: 'F:\\Code\\web', at: '2026-11-03T10:00:00.000Z' }], { limit: 1 })
    expect(folder).toEqual({ path: 'F:\\Code\\web', name: 'web', parent: 'F:\\Code', lastUsed: '2026-11-03T10:00:00.000Z' })
  })

  it('puts uses without a valid time last', () => {
    const list = recentFolders(
      [
        { path: '/a', at: 'nonsense' },
        { path: '/b', at: '2026-01-01T00:00:00.000Z' },
      ],
      { limit: 5 },
    )
    expect(list.map((f) => f.path)).toEqual(['/b', '/a'])
  })
})
