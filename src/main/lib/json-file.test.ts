import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJson, readJsonSync, writeJsonAtomic, writeJsonAtomicSync } from './json-file'

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
