import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isInside, uploadProblem } from './upload-policy'

let root: string
let project: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cm-upload-'))
  project = join(root, 'project')
  outside = join(root, 'home')
  await mkdir(join(project, 'fixtures'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(project, 'fixtures', 'photo.png'), 'x')
  await writeFile(join(project, '.env'), 'SECRET=1')
  await writeFile(join(outside, 'notes.txt'), 'x')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('uploadProblem', () => {
  it('allows files in the session folder', () => {
    expect(uploadProblem(join(project, 'fixtures', 'photo.png'), [project])).toBeNull()
  })

  it('refuses files outside the allowed folders', () => {
    expect(uploadProblem(join(outside, 'notes.txt'), [project])).toContain("Only files in the session's folder")
  })

  it('refuses keys and credentials, also in the session folder', () => {
    expect(uploadProblem(join(project, '.env'), [project])).toContain('looks like a key or credentials file')
  })

  it('refuses missing files, folders and relative paths', () => {
    expect(uploadProblem(join(project, 'nope.png'), [project])).toContain('No such file')
    expect(uploadProblem(join(project, 'fixtures'), [project])).toContain('No such file')
    expect(uploadProblem('fixtures/photo.png', [project])).toContain('Not an absolute path')
  })

  it('follows links: a link in the project to a file outside does not count as inside', async () => {
    const link = join(project, 'linked.txt')
    try {
      await symlink(join(outside, 'notes.txt'), link)
    } catch {
      return // Windows without the right to create symbolic links
    }
    expect(uploadProblem(link, [project])).toContain("Only files in the session's folder")
  })

  it('refuses network paths on Windows without touching them', () => {
    expect(uploadProblem('\\\\server\\share\\file.png', [project], 'win32')).toContain('network shares')
    expect(uploadProblem('//server/share/file.png', [project], 'win32')).toContain('network shares')
  })
})

describe('isInside', () => {
  it('knows a folder, what lies in it and what does not', () => {
    expect(isInside(join(project, 'a', 'b'), project)).toBe(true)
    expect(isInside(project, project)).toBe(true)
    expect(isInside(join(root, 'project-2', 'x'), project)).toBe(false)
    expect(isInside(join(project, '..', 'home', 'x'), project)).toBe(false)
  })
})
