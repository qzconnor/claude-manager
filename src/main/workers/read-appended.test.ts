import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAppended } from './read-appended'

describe('readAppended', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'read-appended-'))
    file = join(dir, 'session.jsonl')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads only the lines added after the part read before', async () => {
    const first = '{"a":1}\n{"b":2}\n'
    await writeFile(file, first)
    await appendFile(file, '{"c":3}\n')
    const appended = await readAppended(file, Buffer.byteLength(first), Buffer.byteLength(first) + 8)
    expect(appended?.toString()).toBe('{"c":3}\n')
  })

  it('gives nothing new, not null, when the file did not grow', async () => {
    await writeFile(file, '{"a":1}\n')
    const appended = await readAppended(file, 8, 8)
    expect(appended?.length).toBe(0)
  })

  it('asks for a full read when nothing was read yet', async () => {
    await writeFile(file, '{"a":1}\n')
    expect(await readAppended(file, 0, 8)).toBeNull()
  })

  it('asks for a full read when the file was written anew and no longer continues the old part', async () => {
    // Before: 8 bytes ending in a newline. Now another file of the same start length, without a line end there.
    await writeFile(file, '{"x":"longer"}\n')
    expect(await readAppended(file, 8, 15)).toBeNull()
  })

  it('counts in bytes, so lines with umlauts don’t shift the offset', async () => {
    const first = '{"t":"Größe"}\n'
    await writeFile(file, first + '{"u":"ä"}\n')
    const offset = Buffer.byteLength(first)
    const appended = await readAppended(file, offset, offset + Buffer.byteLength('{"u":"ä"}\n'))
    expect(appended?.toString('utf8')).toBe('{"u":"ä"}\n')
  })
})
