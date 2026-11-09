import type { IBuffer, IBufferCell, IBufferLine, ILink, Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { addedImageRef, countImageRefs, imageRefs, pastedImageLinks } from './pasted-image-links'

/** A row of the terminal; characters in `wide` take two columns. */
function row(text: string, wide = new Set<string>()): IBufferLine {
  const cells: { chars: string; width: number }[] = []
  for (const char of text) {
    if (wide.has(char)) cells.push({ chars: char, width: 2 }, { chars: '', width: 0 })
    else cells.push({ chars: char, width: 1 })
  }
  return {
    isWrapped: false,
    length: cells.length,
    translateToString: () => text,
    getCell: (x: number) => {
      const cell = cells[x]
      return cell ? ({ getChars: () => cell.chars, getWidth: () => cell.width } as IBufferCell) : undefined
    },
  } as unknown as IBufferLine
}

describe('imageRefs', () => {
  it('finds each [Image #N] with its columns', () => {
    expect(imageRefs(row('❯ [Image #3] [Image #12] so?'))).toEqual([
      { id: 3, start: 2, end: 11 },
      { id: 12, start: 13, end: 23 },
    ])
  })

  it('counts the columns of wide characters before it', () => {
    expect(imageRefs(row('🖼 [Image #1]', new Set(['🖼'])))).toEqual([{ id: 1, start: 3, end: 12 }])
  })

  it('finds nothing in other rows', () => {
    expect(imageRefs(row('[Image #] [Image #x] Image #1'))).toEqual([])
  })
})

describe('countImageRefs and addedImageRef', () => {
  const buffer = (...texts: string[]) => ({ length: texts.length, getLine: (y: number) => (texts[y] === undefined ? undefined : row(texts[y])) }) as unknown as IBuffer

  it('counts the [Image #N] in the rows asked for', () => {
    const rows = buffer('❯ [Image #1] alt', 'x', '❯ [Image #1] [Image #2]', '')
    expect(countImageRefs(rows, -5, 99)).toEqual(new Map([[1, 2], [2, 1]]))
    expect(countImageRefs(rows, 1, 3)).toEqual(new Map([[1, 1], [2, 1]]))
  })

  it('finds the image that came at the cursor', () => {
    const before = countImageRefs(buffer('❯ [Image #1] alt', '❯ [Image #2] '), 0, 2)
    expect(addedImageRef(before, countImageRefs(buffer('❯ [Image #1] alt', '❯ [Image #2] [Image #3] '), 0, 2))).toBe(3)
    // A resumed session counts from 1 again: the same number once more is the new image.
    expect(addedImageRef(before, countImageRefs(buffer('❯ [Image #1] alt', '❯ [Image #2] [Image #1] '), 0, 2))).toBe(1)
    expect(addedImageRef(before, before)).toBeNull()
    // The prompt was redrawn without an image: nothing came.
    expect(addedImageRef(before, countImageRefs(buffer('❯ [Image #1] alt', '❯ '), 0, 2))).toBeNull()
  })
})

describe('pastedImageLinks', () => {
  const terminal = (lines: IBufferLine[]) => ({ buffer: { active: { getLine: (y: number) => lines[y] } } }) as unknown as Terminal

  function links(provider: ReturnType<typeof pastedImageLinks>, y: number): Promise<ILink[] | undefined> {
    return new Promise((resolve) => provider.provideLinks(y, resolve))
  }

  it('links only the images there is something to show for', async () => {
    const options = { ids: vi.fn(async () => new Set([2])), hover: vi.fn(), leave: vi.fn(), open: vi.fn() }
    const provider = pastedImageLinks(terminal([row('x'), row('[Image #1] [Image #2]')]), options)
    const found = await links(provider, 2)
    expect(found?.map((link) => [link.text, link.range])).toEqual([
      ['[Image #2]', { start: { x: 12, y: 2 }, end: { x: 21, y: 2 } }],
    ])
    found![0]!.activate({} as MouseEvent, '')
    expect(options.open).toHaveBeenCalledWith(2)
  })

  it('answers in the same call when the numbers are known, so a row drawn anew keeps its link', () => {
    const options = { ids: () => new Set([1]), hover: vi.fn(), leave: vi.fn(), open: vi.fn() }
    let found: ILink[] | undefined
    pastedImageLinks(terminal([row('❯ [Image #1]')]), options).provideLinks(1, (links) => (found = links))
    expect(found?.map((link) => link.text)).toEqual(['[Image #1]'])
  })

  it('asks for nothing in rows without an image', async () => {
    const options = { ids: vi.fn(async () => new Set([1])), hover: vi.fn(), leave: vi.fn(), open: vi.fn() }
    expect(await links(pastedImageLinks(terminal([row('nur Text')]), options), 1)).toBeUndefined()
    expect(options.ids).not.toHaveBeenCalled()
  })
})
