import { describe, expect, it } from 'vitest'
import { editedAt, fileKey } from './edited-files'

describe('fileKey', () => {
  it('compares Windows paths without case, separators of both kinds, without a trailing one', () => {
    expect(fileKey('F:\\Projekte\\App\\src\\A.ts', 'win32')).toBe(fileKey('f:/projekte/app/src/a.ts', 'win32'))
    expect(fileKey('F:\\Projekte\\App\\', 'win32')).toBe(fileKey('F:\\Projekte\\App', 'win32'))
    expect(fileKey('F:\\Projekte\\App\\src\\..\\b.ts', 'win32')).toBe(fileKey('F:\\Projekte\\App\\b.ts', 'win32'))
    expect(fileKey('/f/Projekte/App/a.ts', 'win32')).toBe(fileKey('F:\\Projekte\\App\\a.ts', 'win32'))
  })

  it('keeps case elsewhere', () => {
    expect(fileKey('/home/dev/A.ts', 'linux')).not.toBe(fileKey('/home/dev/a.ts', 'linux'))
    expect(fileKey('/home/dev/./x/../a.ts/', 'linux')).toBe('/home/dev/a.ts')
  })
})

describe('editedAt', () => {
  it('is the latest change of the file, whichever way its path was noted', () => {
    const files: [string, string][] = [
      ['F:\\App\\src\\a.ts', '2026-11-05T10:00:00.000Z'],
      ['F:\\App\\README.md', '2026-11-05T12:00:00.000Z'],
      ['f:\\app\\SRC\\a.ts', '2026-11-05T11:00:00.000Z'],
    ]
    expect(editedAt({ files }, 'F:/App/src/a.ts', 'win32')).toBe('2026-11-05T11:00:00.000Z')
    expect(editedAt({ files }, 'F:\\App\\src\\b.ts', 'win32')).toBeNull()
    expect(editedAt({ files }, 'F:\\App\\src\\a.ts', 'linux')).toBe('2026-11-05T10:00:00.000Z')
    expect(editedAt(undefined, 'F:\\App\\src\\a.ts', 'win32')).toBeNull()
    expect(editedAt({}, 'F:\\App\\src\\a.ts', 'win32')).toBeNull()
  })

  it("takes the time of Claude's latest call over that of a later backup, which someone else's change may have caused", () => {
    const session = {
      files: [
        ['/app/a.ts', '2026-11-09T08:00:00.000Z'],
        ['/app/b.ts', '2026-11-08T08:00:00.000Z'],
      ] as [string, string][],
      edits: [
        ['/app/a.ts', '2026-11-01T10:00:00.000Z'],
        ['/app/a.ts', '2026-11-02T10:00:00.000Z'],
        ['/app/c.ts', '2026-11-03T10:00:00.000Z'],
      ] as [string, string][],
    }
    expect(editedAt(session, '/app/a.ts', 'linux')).toBe('2026-11-02T10:00:00.000Z')
    // Changed by a subagent: only backed up.
    expect(editedAt(session, '/app/b.ts', 'linux')).toBe('2026-11-08T08:00:00.000Z')
    // Changed without a backup (file history off).
    expect(editedAt(session, '/app/c.ts', 'linux')).toBe('2026-11-03T10:00:00.000Z')
  })
})
