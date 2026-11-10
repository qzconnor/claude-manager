import { describe, expect, it } from 'vitest'
import { BLOCK_SHAPES, blockGlyphsCss, splitBlocks } from './block-glyphs'

describe('BLOCK_SHAPES', () => {
  it('covers every block character', () => {
    for (let code = 0x2580; code <= 0x259f; code++) expect(BLOCK_SHAPES.has(code), code.toString(16)).toBe(true)
    expect(BLOCK_SHAPES.size).toBe(32)
  })

  it('keeps every part inside the cell, at most two of them (::before, ::after)', () => {
    for (const { rects } of BLOCK_SHAPES.values()) {
      expect(rects.length).toBeLessThanOrEqual(2)
      for (const [x, y, w, h] of rects) {
        expect(x + w).toBeLessThanOrEqual(1)
        expect(y + h).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('splitBlocks', () => {
  it('puts each block character on its own, other text in runs', () => {
    expect(splitBlocks(' ▐▛█')).toEqual([' ', 0x2590, 0x259b, 0x2588])
    expect(splitBlocks('▘▘ ▝▝')).toEqual([0x2598, 0x2598, ' ', 0x259d, 0x259d])
    expect(splitBlocks('Claude 👋 Code')).toEqual(['Claude 👋 Code'])
    expect(splitBlocks('')).toEqual([])
  })
})

describe('blockGlyphsCss', () => {
  const css = blockGlyphsCss()

  it('draws the halves of the crab where they belong', () => {
    // ▐ the right half; ▛ the top half and the left half (inset: top right bottom left).
    expect(css).toContain(".cm-block-2590::before { content: ''; inset: 0 0 0 50%; }")
    expect(css).toContain(".cm-block-259b::before { content: ''; inset: 0 0 50% 0; }")
    expect(css).toContain(".cm-block-259b::after { content: ''; inset: 0 50% 0 0; }")
  })

  it('draws the eighths flush with their edge', () => {
    // ▁ the lower eighth, ▕ the right one, ▉ the left seven.
    expect(css).toContain(".cm-block-2581::before { content: ''; inset: 87.5% 0 0 0; }")
    expect(css).toContain(".cm-block-2595::before { content: ''; inset: 0 0 0 87.5%; }")
    expect(css).toContain(".cm-block-2589::before { content: ''; inset: 0 12.5% 0 0; }")
  })

  it('draws the shades in part of the color', () => {
    expect(css).toContain('.cm-block-2592 { opacity: 0.5; }')
    expect(css).toContain(".cm-block-2592::before { content: ''; inset: 0 0 0 0; }")
  })
})
