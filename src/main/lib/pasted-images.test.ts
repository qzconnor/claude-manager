import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  choosePastedImage,
  newPastedImageScan,
  pastedImagesIn,
  readPastedImage,
  scanPastedImages,
  type PastedImageScan,
} from './pasted-images'

const T0 = Date.parse('2026-11-09T15:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

type Entry = Record<string, unknown>

const text = (value: string): Entry => ({ type: 'text', text: value })
const image = (data: string, mediaType = 'image/png'): Entry => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })

/** A prompt as Claude Code writes it, with the numbers of its pasted images. */
function prompt(content: Entry[], ids: number[], seconds: number, extra: Entry = {}): Entry {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    uuid: `u-${seconds}`,
    timestamp: at(seconds),
    imagePasteIds: ids,
    ...extra,
  }
}

/** A prompt sent while Claude worked, taken into the running turn. */
function queued(content: Entry[], seconds: number): Entry {
  return { type: 'attachment', attachment: { type: 'queued_command', prompt: content }, uuid: `q-${seconds}`, timestamp: at(seconds) }
}

const line = (entry: Entry | string) => (typeof entry === 'string' ? entry : JSON.stringify(entry)) + '\n'

describe('pastedImagesIn', () => {
  it('numbers the images of a prompt by imagePasteIds', () => {
    const entry = prompt([text('[Image #3] [Image #4] so?'), image('AAA'), image('BBB', 'image/jpeg')], [3, 4], 5)
    expect(pastedImagesIn(entry)).toEqual({
      time: T0 + 5000,
      images: [
        { id: 3, mediaType: 'image/png', data: 'AAA' },
        { id: 4, mediaType: 'image/jpeg', data: 'BBB' },
      ],
    })
  })

  it('takes the numbers of a queued prompt from its text, ascending', () => {
    const entry = queued([text('[Image #6] neben [Image #5] und nochmal [Image #6]'), image('FIVE'), image('SIX')], 7)
    expect(pastedImagesIn(entry)?.images.map(({ id, data }) => [id, data])).toEqual([
      [5, 'FIVE'],
      [6, 'SIX'],
    ])
  })

  it('takes the numbers from the text when a prompt has no imagePasteIds', () => {
    const entry = prompt([text('hier [Image #2]'), image('TWO')], [], 1)
    delete entry.imagePasteIds
    expect(pastedImagesIn(entry)?.images).toEqual([{ id: 2, mediaType: 'image/png', data: 'TWO' }])
  })

  it('ignores images of tools, of subagents and of types Claude Code does not send', () => {
    const toolResult = prompt([{ type: 'tool_result', tool_use_id: 't1', content: [image('SHOT')] }], [], 1)
    expect(pastedImagesIn(toolResult)).toBeNull()
    expect(pastedImagesIn(prompt([text('[Image #1]'), image('A')], [1], 1, { isSidechain: true }))).toBeNull()
    expect(pastedImagesIn(prompt([text('[Image #1]'), image('A', 'image/svg+xml')], [1], 1))).toBeNull()
    expect(pastedImagesIn(prompt([text('kein Bild')], [], 1))).toBeNull()
    expect(pastedImagesIn({ type: 'assistant', message: { content: [image('A')] } })).toBeNull()
  })

  it('leaves out images without a number', () => {
    expect(pastedImagesIn(prompt([text('[Image #1]'), image('A'), image('B')], [1], 1))?.images).toEqual([
      { id: 1, mediaType: 'image/png', data: 'A' },
    ])
  })
})

describe('scanPastedImages', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
    file = join(dir, 'session.jsonl')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('finds the pasted images and reads them as data URLs', async () => {
    await writeFile(
      file,
      line({ type: 'user', message: { role: 'user', content: 'ohne Bild' }, timestamp: at(0) }) +
        line(prompt([text('[Image #1] das hier'), image('ONE')], [1], 1)) +
        line({ type: 'assistant', message: { content: [text('[Image #1] gesehen')] }, timestamp: at(2) }) +
        line(queued([text('[Image #2] und das'), image('TWO')], 3)),
    )
    const scan = newPastedImageScan()
    await scanPastedImages(file, scan)
    expect([...scan.images.keys()]).toEqual([1, 2])
    expect(await readPastedImage(file, scan.images.get(1)![0]!, 1)).toBe('data:image/png;base64,ONE')
    expect(await readPastedImage(file, scan.images.get(2)![0]!, 2)).toBe('data:image/png;base64,TWO')
    expect(await readPastedImage(file, scan.images.get(2)![0]!, 1)).toBeNull()
  })

  it('reads on from where it stopped, a line still being written next time', async () => {
    await writeFile(file, line(prompt([text('[Image #1]'), image('ONE')], [1], 1)))
    const scan = newPastedImageScan()
    await scanPastedImages(file, scan)
    const half = JSON.stringify(prompt([text('[Image #2]'), image('TWO')], [2], 2))
    await appendFile(file, half.slice(0, 40))
    await scanPastedImages(file, scan)
    expect([...scan.images.keys()]).toEqual([1])
    await appendFile(file, half.slice(40) + '\n')
    await scanPastedImages(file, scan)
    expect([...scan.images.keys()]).toEqual([1, 2])
    expect(scan.images.get(1)).toHaveLength(1)
    expect(await readPastedImage(file, scan.images.get(2)![0]!, 2)).toBe('data:image/png;base64,TWO')
  })

  it('reads lines longer than one piece of the file', async () => {
    const big = 'A'.repeat(5 * 1024 * 1024)
    await writeFile(file, line(prompt([text('[Image #1]'), image(big)], [1], 1)) + line(prompt([text('[Image #2]'), image('TWO')], [2], 2)))
    const scan = newPastedImageScan()
    await scanPastedImages(file, scan)
    expect([...scan.images.keys()]).toEqual([1, 2])
    expect((await readPastedImage(file, scan.images.get(1)![0]!, 1))?.length).toBe('data:image/png;base64,'.length + big.length)
  })

  it('starts over when the file got shorter', async () => {
    await writeFile(file, line(prompt([text('[Image #1]'), image('ONE')], [1], 1)) + line(prompt([text('[Image #2]'), image('TWO')], [2], 2)))
    const scan = newPastedImageScan()
    await scanPastedImages(file, scan)
    await writeFile(file, line(prompt([text('[Image #3]'), image('X')], [3], 3)))
    await scanPastedImages(file, scan)
    expect([...scan.images.keys()]).toEqual([3])
  })

  it('keeps every line with the same number: a resumed session counts from 1 again', async () => {
    await writeFile(file, line(prompt([text('[Image #1]'), image('OLD')], [1], 1)) + line(prompt([text('[Image #1]'), image('NEW')], [1], 100)))
    const scan = newPastedImageScan()
    await scanPastedImages(file, scan)
    // Two scans at once don't count a line twice.
    await Promise.all([scanPastedImages(file, scan), scanPastedImages(file, scan)])
    expect(scan.images.get(1)?.map((entry) => entry.time)).toEqual([T0 + 1000, T0 + 100_000])
  })
})

describe('choosePastedImage', () => {
  const scanOf = (images: [number, number, number][]): PastedImageScan => {
    const scan = newPastedImageScan()
    for (const [id, position, time] of images) scan.images.set(id, [...(scan.images.get(id) ?? []), { position, time }])
    return scan
  }

  it('takes the latest image the process sent, in the current session first', () => {
    const current = { name: 'current', scan: scanOf([[1, 10, 50]]) }
    const before = { name: 'before', scan: scanOf([[1, 0, 40], [2, 30, 45]]) }
    expect(choosePastedImage([current, before], 1, 30)).toEqual({ transcript: current, at: { position: 10, time: 50 } })
    expect(choosePastedImage([current, before], 2, 30)).toEqual({ transcript: before, at: { position: 30, time: 45 } })
    expect(choosePastedImage([current, before], 3, 30)).toBeNull()
  })

  it('prefers an image of this process over one with the same number from before it was resumed', () => {
    const resumed = {
      scan: scanOf([
        [1, 0, 10],
        [1, 20, 100],
        [2, 40, 20],
      ]),
    }
    expect(choosePastedImage([resumed], 1, 50)?.at).toEqual({ position: 20, time: 100 })
    // Only from before: the latest of those.
    expect(choosePastedImage([resumed], 2, 50)?.at).toEqual({ position: 40, time: 20 })
  })
})
