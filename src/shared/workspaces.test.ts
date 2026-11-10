import { describe, expect, it } from 'vitest'
import { pathSegments, workspaceNameError, workspaceOf, workspacesContaining } from './workspaces'

describe('workspaceNameError', () => {
  it('takes names that make a folder', () => {
    expect(workspaceNameError('Webseiten')).toBeNull()
    expect(workspaceNameError('  Kunden 2026 ')).toBeNull()
    expect(workspaceNameError('a.b-c_d (alt)')).toBeNull()
  })

  it('asks for a name', () => {
    expect(workspaceNameError('')).not.toBeNull()
    expect(workspaceNameError('   ')).not.toBeNull()
  })

  it('refuses what Windows doesn’t allow in a folder name', () => {
    for (const name of ['a/b', 'a\\b', 'a:b', 'a*', 'a?', 'a"b', '<a>', 'a|b', 'a.', '..', 'CON', 'nul.txt', 'com1']) {
      expect(workspaceNameError(name), name).not.toBeNull()
    }
    expect(workspaceNameError('console')).toBeNull()
  })

  it('refuses names that are too long', () => {
    expect(workspaceNameError('a'.repeat(121))).not.toBeNull()
  })
})

describe('pathSegments', () => {
  it('splits Windows, UNC and POSIX paths', () => {
    expect(pathSegments('C:\\a\\b\\')).toEqual(['C:', 'a', 'b'])
    expect(pathSegments('c:/a//b')).toEqual(['c:', 'a', 'b'])
    expect(pathSegments('\\\\server\\share\\x')).toEqual(['server', 'share', 'x'])
    expect(pathSegments('/home/me')).toEqual(['home', 'me'])
  })
})

describe('workspacesContaining', () => {
  const folders = ['F:\\Webseiten\\Kunden', 'F:\\Webseiten', 'F:\\Andere']

  it('lists the workspaces a folder lies in, the outermost first', () => {
    expect(workspacesContaining('f:/webseiten/kunden/acme/src', folders)).toEqual(['F:\\Webseiten', 'F:\\Webseiten\\Kunden'])
    expect(workspacesContaining('F:\\Webseiten', folders)).toEqual(['F:\\Webseiten'])
    expect(workspacesContaining('F:\\Webseiten-alt', folders)).toEqual([])
  })

  it('names the innermost one as the workspace of a folder', () => {
    expect(workspaceOf('F:\\Webseiten\\Kunden\\acme', folders)).toBe('F:\\Webseiten\\Kunden')
    expect(workspaceOf('F:\\Webseiten\\websiteA', folders)).toBe('F:\\Webseiten')
    expect(workspaceOf('C:\\', folders)).toBeNull()
  })
})
