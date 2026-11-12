import { describe, expect, it } from 'vitest'
import { trimCanvasFonts, type CanvasRealm } from './canvas-font'

/** A 2D context that takes a font like a canvas: the last valid one, `10px sans-serif` at first. */
function contextClass(acceptsLeadingSpace: boolean) {
  return class FakeContext {
    private value = '10px sans-serif'
    get font(): string {
      return this.value
    }
    set font(font: string) {
      if (!acceptsLeadingSpace && /^\s/.test(font)) return
      this.value = font
    }
  }
}

function realm(acceptsLeadingSpace: boolean) {
  const Canvas = contextClass(acceptsLeadingSpace)
  const Offscreen = contextClass(acceptsLeadingSpace)
  const fake = {
    document: { createElement: () => ({ getContext: () => new Canvas() }) },
    CanvasRenderingContext2D: Canvas,
    OffscreenCanvasRenderingContext2D: Offscreen,
  } satisfies CanvasRealm
  return fake
}

describe('trimCanvasFonts', () => {
  it('trims the fonts of both kinds of canvas where a leading space is rejected', () => {
    const r = realm(false)
    expect(trimCanvasFonts(r)).toBe(true)
    // How xterm's WebGL renderer builds the font of upright text.
    const canvas = new r.CanvasRenderingContext2D()
    canvas.font = ' 400 28px "Cascadia Code", monospace'
    expect(canvas.font).toBe('400 28px "Cascadia Code", monospace')
    const offscreen = new r.OffscreenCanvasRenderingContext2D()
    offscreen.font = '\tbold 14px Consolas '
    expect(offscreen.font).toBe('bold 14px Consolas')
  })

  it('leaves the canvases alone where the font is taken as it is', () => {
    const r = realm(true)
    expect(trimCanvasFonts(r)).toBe(false)
    const canvas = new r.CanvasRenderingContext2D()
    canvas.font = ' 400 28px Consolas'
    expect(canvas.font).toBe(' 400 28px Consolas')
  })

  it('does nothing without a 2D canvas', () => {
    const r = { ...realm(false), document: { createElement: () => ({ getContext: () => null }) } }
    expect(trimCanvasFonts(r)).toBe(false)
    const canvas = new r.CanvasRenderingContext2D()
    canvas.font = ' 12px Consolas'
    expect(canvas.font).toBe('10px sans-serif')
  })

  it('copes with a window without OffscreenCanvas', () => {
    const r = realm(false)
    expect(trimCanvasFonts({ document: r.document, CanvasRenderingContext2D: r.CanvasRenderingContext2D })).toBe(true)
    const canvas = new r.CanvasRenderingContext2D()
    canvas.font = ' 12px Consolas'
    expect(canvas.font).toBe('12px Consolas')
  })
})
