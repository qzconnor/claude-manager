import { describe, expect, it } from 'vitest'
import { MAX_NAME_LENGTH, nameProblem, pathProblem } from './file-names'

describe('nameProblem', () => {
  it('takes ordinary names, also with umlauts, spaces and dots inside', () => {
    for (const name of ['README.md', 'Größe der Datei.txt', '.env', 'a.b.c', 'console.log']) {
      expect(nameProblem(name, 'win32')).toBeNull()
      expect(nameProblem(name, 'linux')).toBeNull()
    }
  })

  it('refuses empty names, dots, slashes, overlong ones and .git everywhere', () => {
    for (const platform of ['win32', 'linux']) {
      expect(nameProblem('', platform)).toMatch(/Namen/)
      expect(nameProblem('   ', platform)).toMatch(/Namen/)
      expect(nameProblem('.', platform)).not.toBeNull()
      expect(nameProblem('..', platform)).not.toBeNull()
      expect(nameProblem('a/b', platform)).toMatch(/„\/“/)
      expect(nameProblem('x'.repeat(MAX_NAME_LENGTH + 1), platform)).toMatch(/zu lang/)
      expect(nameProblem('.GIT', platform)).toMatch(/Git/)
    }
  })

  it('refuses what Windows does not take, only there', () => {
    for (const name of ['a:b', 'what?', 'x*', 'a"b', 'a<b', 'a|b', 'a\\b', 'tab\there']) {
      expect(nameProblem(name, 'win32')).toMatch(/Zeichen/)
      expect(nameProblem(name, 'linux')).toBeNull()
    }
    expect(nameProblem('name.', 'win32')).toMatch(/Punkt oder Leerzeichen/)
    expect(nameProblem('name ', 'win32')).toMatch(/Punkt oder Leerzeichen/)
    expect(nameProblem('NUL', 'win32')).toMatch(/Gerätename/)
    expect(nameProblem('com1.txt', 'win32')).toMatch(/„com1“/)
    expect(nameProblem('NUL', 'linux')).toBeNull()
  })
})

describe('pathProblem', () => {
  it('checks each part of a path', () => {
    expect(pathProblem('src/lib/new.ts', 'win32')).toBeNull()
    expect(pathProblem('src/a:b/new.ts', 'win32')).toMatch(/Zeichen/)
    expect(pathProblem('src/.git/x', 'linux')).toMatch(/Git/)
    expect(pathProblem('', 'linux')).toMatch(/Namen/)
  })

  it('refuses empty parts', () => {
    for (const path of ['/a', 'a/', 'a//b']) expect(pathProblem(path, 'linux')).toMatch(/leeren Teil/)
  })
})
