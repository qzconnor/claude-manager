import { describe, expect, it } from 'vitest'
import { stemEnd, typedPath, type NameRequest } from './tree-names'

const create: NameRequest = { kind: 'file', parent: 'src', name: '', dir: false }
const rename: NameRequest = { kind: 'rename', parent: '', name: 'old.ts', dir: false }

describe('typedPath', () => {
  it('puts the name in the folder, without the spaces around it', () => {
    expect(typedPath(create, '  new.ts ', 'linux')).toEqual({ path: 'src/new.ts', problem: null })
    expect(typedPath(rename, 'new.ts', 'linux')).toEqual({ path: 'new.ts', problem: null })
  })

  it('lets a new entry name folders on its way, on Windows also with a backslash', () => {
    expect(typedPath(create, 'lib/deep/new.ts', 'linux').path).toBe('src/lib/deep/new.ts')
    expect(typedPath(create, 'lib\\new.ts', 'win32')).toEqual({ path: 'src/lib/new.ts', problem: null })
    // On Linux a backslash is part of the name.
    expect(typedPath(create, 'lib\\new.ts', 'linux').path).toBe('src/lib\\new.ts')
  })

  it('gives a new name for an entry as one name', () => {
    expect(typedPath(rename, 'lib/new.ts', 'linux').problem).toMatch(/„\/“/)
    expect(typedPath(rename, 'a\\b', 'win32').problem).toMatch(/Zeichen/)
  })

  it('says what is wrong with the name', () => {
    expect(typedPath(create, '', 'linux').problem).toMatch(/Namen/)
    expect(typedPath(create, 'a//b', 'linux').problem).toMatch(/leeren Teil/)
    expect(typedPath(create, 'what?.ts', 'win32').problem).toMatch(/Zeichen/)
  })
})

describe('stemEnd', () => {
  it('selects a file name up to its extension, a folder and a dotfile whole', () => {
    expect(stemEnd('file-tree.test.ts', false)).toBe('file-tree.test'.length)
    expect(stemEnd('Makefile', false)).toBe(8)
    expect(stemEnd('.env', false)).toBe(4)
    expect(stemEnd('v1.2', true)).toBe(4)
  })
})
