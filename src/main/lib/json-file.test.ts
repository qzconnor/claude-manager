import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJson, readJsonGuarded, readJsonGuardedSync, readJsonSync, takeJsonProblems, writeJsonAtomic, writeJsonAtomicSync } from './json-file'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe.each([
  ['readJson', (file: string) => readJson<unknown>(file)],
  ['readJsonSync', (file: string) => Promise.resolve(readJsonSync<unknown>(file))],
])('%s', (_name, read) => {
  it('parses a JSON file', async () => {
    await writeFile(join(dir, 'a.json'), '{"a":1,"b":[true,null]}')
    expect(await read(join(dir, 'a.json'))).toEqual({ a: 1, b: [true, null] })
  })

  it('skips a byte order mark, as Windows editors write it', async () => {
    await writeFile(join(dir, 'bom.json'), '﻿{"name":"Ä"}', 'utf8')
    expect(await read(join(dir, 'bom.json'))).toEqual({ name: 'Ä' })
  })

  it('returns null for a missing file', async () => {
    expect(await read(join(dir, 'missing.json'))).toBeNull()
  })

  it('returns null for invalid or truncated JSON', async () => {
    await writeFile(join(dir, 'bad.json'), '{"a":1')
    await writeFile(join(dir, 'empty.json'), '')
    expect(await read(join(dir, 'bad.json'))).toBeNull()
    expect(await read(join(dir, 'empty.json'))).toBeNull()
  })

  it('returns null for a folder', async () => {
    await mkdir(join(dir, 'folder.json'))
    expect(await read(join(dir, 'folder.json'))).toBeNull()
  })
})

describe('writeJsonAtomic', () => {
  it('writes indented JSON with a final newline and creates missing folders', async () => {
    const file = join(dir, 'nested', 'deeper', 'state.json')
    await writeJsonAtomic(file, { a: 1, list: ['x'] })
    expect(await readFile(file, 'utf8')).toBe('{\n  "a": 1,\n  "list": [\n    "x"\n  ]\n}\n')
  })

  it('replaces the file and leaves no temp file behind', async () => {
    const file = join(dir, 'state.json')
    await writeFile(file, '{"old":true}')
    await writeJsonAtomic(file, { new: true })
    expect(await readJson(file)).toEqual({ new: true })
    expect(await readdir(dir)).toEqual(['state.json'])
  })

  it('keeps the order of concurrent writes to the same file, the last one wins', async () => {
    const file = join(dir, 'state.json')
    const writes = Array.from({ length: 10 }, (_, i) => writeJsonAtomic(file, { i }))
    await Promise.all(writes)
    expect(await readJson(file)).toEqual({ i: 9 })
    expect(await readdir(dir)).toEqual(['state.json'])
  })

  it('writes different files independently', async () => {
    await Promise.all([writeJsonAtomic(join(dir, 'a.json'), 'a'), writeJsonAtomic(join(dir, 'b.json'), 'b')])
    expect(await readJson(join(dir, 'a.json'))).toBe('a')
    expect(await readJson(join(dir, 'b.json'))).toBe('b')
  })

  // A failed write rejects only for the caller; an unhandled rejection besides would fail this run.
  it('reports a failed write to the caller only and goes on with the next one', async () => {
    const target = join(dir, 'busy')
    await mkdir(join(target, 'inside'), { recursive: true })
    await expect(writeJsonAtomic(target, { lost: true })).rejects.toThrow()
    const other = join(dir, 'other.json')
    await writeJsonAtomic(other, { ok: true })
    expect(await readJson(other)).toEqual({ ok: true })
    expect((await readdir(dir)).sort()).toEqual(['busy', 'other.json'])
  })
})

describe('writeJsonAtomicSync', () => {
  it('writes indented JSON with a final newline and creates missing folders', async () => {
    const file = join(dir, 'nested', 'state.json')
    writeJsonAtomicSync(file, { ok: true })
    expect(await readFile(file, 'utf8')).toBe('{\n  "ok": true\n}\n')
    expect(await readdir(join(dir, 'nested'))).toEqual(['state.json'])
  })

  it('throws and removes its temp file when the target cannot be replaced', async () => {
    // A non-empty folder can't be replaced by a file on any platform.
    const file = join(dir, 'state.json')
    mkdirSync(join(file, 'inside'), { recursive: true })
    expect(() => writeJsonAtomicSync(file, { a: 1 })).toThrow()
    expect(await readdir(dir)).toEqual(['state.json'])
  })
})

describe.each([
  ['readJsonGuarded', (file: string) => readJsonGuarded<unknown>(file)],
  ['readJsonGuardedSync', (file: string) => Promise.resolve(readJsonGuardedSync<unknown>(file))],
])('%s', (_name, read) => {
  afterEach(() => {
    takeJsonProblems()
  })

  it('reads a valid file and reports nothing', async () => {
    await writeFile(join(dir, 'a.json'), '{"a":1}')
    expect(await read(join(dir, 'a.json'))).toEqual({ a: 1 })
    expect(takeJsonProblems()).toEqual([])
  })

  it('returns null for a missing file, without a message', async () => {
    expect(await read(join(dir, 'missing.json'))).toBeNull()
    expect(takeJsonProblems()).toEqual([])
  })

  it('moves a broken file aside and loads the last good version', async () => {
    const file = join(dir, 'accounts.json')
    await writeFile(file, '')
    await writeFile(`${file}.bak`, '{"accounts":[1]}')
    expect(await read(file)).toEqual({ accounts: [1] })
    // The good version is back in place, the broken one kept beside it.
    expect(await readJson(file)).toEqual({ accounts: [1] })
    const names = await readdir(dir)
    expect(names.some((name) => name.startsWith('accounts.json.broken-'))).toBe(true)
    const [problem] = takeJsonProblems()
    expect(problem.file).toBe(file)
    expect(problem.message).toContain('letzte funktionierende Fassung')
  })

  it('keeps a broken file without backup and starts empty', async () => {
    const file = join(dir, 'settings.json')
    await writeFile(file, '{"a":')
    expect(await read(file)).toBeNull()
    const names = await readdir(dir)
    expect(names.some((name) => name.startsWith('settings.json.broken-'))).toBe(true)
    expect(takeJsonProblems()[0].message).toContain('keine frühere Fassung')
    // The file was moved aside, so a new state may be written.
    await writeJsonAtomic(file, { fresh: true }, { guarded: true })
    expect(await readJson(file)).toEqual({ fresh: true })
  })
})

describe('guarded writes', () => {
  afterEach(() => {
    takeJsonProblems()
  })

  it('keeps the previous valid version as .bak', async () => {
    const file = join(dir, 'state.json')
    await writeJsonAtomic(file, { v: 1 }, { guarded: true })
    await writeJsonAtomic(file, { v: 2 }, { guarded: true })
    expect(await readJson(file)).toEqual({ v: 2 })
    expect(await readJson(`${file}.bak`)).toEqual({ v: 1 })
    writeJsonAtomicSync(file, { v: 3 }, { guarded: true })
    expect(await readJson(`${file}.bak`)).toEqual({ v: 2 })
  })

  it('does not keep an invalid file as .bak', async () => {
    const file = join(dir, 'state.json')
    await writeFile(`${file}.bak`, '{"good":true}')
    await writeFile(file, 'not json')
    await writeJsonAtomic(file, { v: 1 }, { guarded: true })
    expect(await readJson(`${file}.bak`)).toEqual({ good: true })
  })

  it('refuses to replace a file that could not be read', async () => {
    // A folder can't be read as a file: like a file locked by another program.
    const file = join(dir, 'locked.json')
    await mkdir(file)
    expect(await readJsonGuarded(file)).toBeNull()
    expect(takeJsonProblems()[0].message).toContain('ließ sich nicht lesen')
    await expect(writeJsonAtomic(file, { lost: true }, { guarded: true })).rejects.toThrow('erst nach einem Neustart')
    expect(() => writeJsonAtomicSync(file, { lost: true }, { guarded: true })).toThrow('erst nach einem Neustart')
  }, 10_000)
})
