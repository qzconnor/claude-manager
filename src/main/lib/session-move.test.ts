import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { moveSessions, projectFolderName } from './session-move'

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const S3 = '33333333-3333-4333-8333-333333333333'

describe('projectFolderName', () => {
  it('is the path with every other character a dash', () => {
    expect(projectFolderName('F:\\Kunden\\shop')).toBe('F--Kunden-shop')
  })

  it('shortens long paths with a hash, like Claude Code', () => {
    const long = `F:\\${'a'.repeat(250)}`
    const name = projectFolderName(long)
    expect(name.startsWith(`F--${'a'.repeat(197)}-`)).toBe(true)
    expect(name.length).toBeGreaterThan(201)
    expect(projectFolderName(long)).toBe(name)
    expect(projectFolderName(`${long}b`)).not.toBe(name)
  })
})

describe('moveSessions', () => {
  let projects: string

  beforeEach(() => {
    projects = mkdtempSync(join(tmpdir(), 'cm-move-'))
  })

  afterEach(() => {
    rmSync(projects, { recursive: true, force: true })
  })

  function transcript(cwd: string, id: string, text = '{"type":"user"}\n'): string {
    const dir = join(projects, projectFolderName(cwd))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${id}.jsonl`)
    writeFileSync(file, text)
    return file
  }

  const lines = (file: string) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)

  it('moves the sessions of the folder and below it, as /cd does', async () => {
    const own = transcript('F:\\Kunden\\shop', S1)
    mkdirSync(join(projects, 'F--Kunden-shop', S1, 'subagents'), { recursive: true })
    mkdirSync(join(projects, 'F--Kunden-shop', 'memory'))
    writeFileSync(join(projects, 'F--Kunden-shop', 'memory', 'MEMORY.md'), '- x')
    const deep = transcript('F:\\Kunden\\shop\\src', S2, '{"type":"user"}')
    const other = transcript('F:\\Kunden\\shop-alt', S3)

    const result = await moveSessions(
      projects,
      [
        { id: S1, cwd: 'F:\\Kunden\\shop', filePath: own },
        { id: S2, cwd: 'f:/kunden/shop/src', filePath: deep },
        { id: S3, cwd: 'F:\\Kunden\\shop-alt', filePath: other },
      ],
      'F:\\Kunden\\shop',
      'F:\\Andere\\shop',
      new Set(),
    )

    expect(result).toEqual({ moved: 2, skipped: 0 })
    const moved = join(projects, 'F--Andere-shop', `${S1}.jsonl`)
    expect(lines(moved).at(-1)).toEqual({ type: 'relocated', sessionId: S1, relocatedCwd: 'F:\\Andere\\shop' })
    expect(existsSync(join(projects, 'F--Andere-shop', S1, 'subagents'))).toBe(true)
    expect(readFileSync(join(projects, 'F--Andere-shop', 'memory', 'MEMORY.md'), 'utf8')).toBe('- x')
    // A transcript ending in the middle of a line gets the entry on a line of its own.
    expect(lines(join(projects, 'F--Andere-shop-src', `${S2}.jsonl`))).toEqual([
      { type: 'user' },
      { type: 'relocated', sessionId: S2, relocatedCwd: 'F:\\Andere\\shop\\src' },
    ])
    // The emptied project folders go, the neighbour stays.
    expect(existsSync(join(projects, 'F--Kunden-shop'))).toBe(false)
    expect(existsSync(join(projects, 'F--Kunden-shop-src'))).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('leaves sessions that are open in a running Claude Code, or already there', async () => {
    const running = transcript('F:\\Kunden\\shop', S1)
    const copied = transcript('F:\\Kunden\\shop', S2)
    transcript('F:\\Andere\\shop', S2, '{"type":"assistant"}\n')

    const result = await moveSessions(
      projects,
      [
        { id: S1, cwd: 'F:\\Kunden\\shop', filePath: running },
        { id: S2, cwd: 'F:\\Kunden\\shop', filePath: copied },
      ],
      'F:\\Kunden\\shop',
      'F:\\Andere\\shop',
      new Set([S1]),
    )

    expect(result).toEqual({ moved: 0, skipped: 2 })
    expect(lines(running)).toEqual([{ type: 'user' }])
    expect(lines(join(projects, 'F--Andere-shop', `${S2}.jsonl`))).toEqual([{ type: 'assistant' }])
  })
})
