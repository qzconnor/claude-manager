import { describe, expect, it } from 'vitest'
import { KeptImages, MAX_KEPT_IMAGE_BYTES, MAX_KEPT_IMAGES_PER_TAB } from './kept-images'

const image = (bytes: number, fill = 1) => ({ mediaType: 'image/png', data: Buffer.alloc(bytes, fill) })

describe('KeptImages', () => {
  it('gives an image back as a data URL until it is deleted', () => {
    const kept = new KeptImages()
    kept.keep('t', 1, { mediaType: 'image/png', data: Buffer.from('PNG') })
    expect(kept.get('t', 1)).toBe(`data:image/png;base64,${Buffer.from('PNG').toString('base64')}`)
    expect(kept.get('other', 1)).toBeNull()
    kept.delete('t', 1)
    expect(kept.get('t', 1)).toBeNull()
    expect(kept.bytes).toBe(0)
  })

  it('replaces an image pasted again with the same number', () => {
    const kept = new KeptImages()
    kept.keep('t', 1, image(10))
    kept.keep('t', 1, image(4, 2))
    expect(kept.ids('t')).toEqual([1])
    expect(kept.bytes).toBe(4)
  })

  it('keeps the newest of a tab within its count', () => {
    const kept = new KeptImages()
    kept.keep('other', 1, image(1))
    for (let n = 1; n <= MAX_KEPT_IMAGES_PER_TAB + 2; n++) kept.keep('t', n, image(1))
    expect(kept.ids('t')).toHaveLength(MAX_KEPT_IMAGES_PER_TAB)
    expect(kept.ids('t')[0]).toBe(3)
    // Another tab's image stays.
    expect(kept.ids('other')).toEqual([1])
  })

  it('lets the oldest of all tabs go once they hold more than the budget together', () => {
    const kept = new KeptImages(100)
    kept.keep('a', 1, image(40))
    kept.keep('b', 1, image(40))
    kept.keep('a', 2, image(40))
    expect(kept.ids('a')).toEqual([2])
    expect(kept.ids('b')).toEqual([1])
    expect(kept.bytes).toBe(80)
    // One larger than the whole budget isn't kept, and pushes nothing out.
    kept.keep('c', 1, image(101))
    expect(kept.ids('c')).toEqual([])
    expect(kept.bytes).toBe(80)
  })

  it('lets a closed tab take its images along', () => {
    const kept = new KeptImages()
    kept.keep('a', 1, image(5))
    kept.keep('a', 2, image(5))
    kept.keep('b', 1, image(5))
    kept.forget('a')
    expect(kept.ids('a')).toEqual([])
    expect(kept.bytes).toBe(5)
  })

  it('has room for two of the largest images the clipboard gives', () => {
    expect(MAX_KEPT_IMAGE_BYTES).toBeGreaterThanOrEqual(2 * 32 * 1024 * 1024)
  })
})
