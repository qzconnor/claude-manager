/** What `trimCanvasFonts` needs of the window: a canvas to try it on and the canvas contexts to correct. */
export interface CanvasRealm {
  document: { createElement(tag: 'canvas'): { getContext(id: '2d'): { font: string } | null } }
  CanvasRenderingContext2D?: { prototype: object }
  OffscreenCanvasRenderingContext2D?: { prototype: object }
}

/**
 * The Chromium of Electron 45.3 rejects a canvas font that starts with a space and keeps
 * `10px sans-serif`. xterm's WebGL renderer builds its font as `${fontStyle} ${fontWeight} …`,
 * with an empty style for upright text, so every glyph came out small and in a sans serif,
 * spread over the cells of the real font. The DOM renderer and everything with CSS fonts weren't
 * hit. Where a canvas rejects such a font, the fonts given to a canvas lose their spaces at the
 * ends first; a Chromium that takes them again leaves the canvases as they are.
 * Returns whether it had to.
 */
export function trimCanvasFonts(realm: CanvasRealm = window): boolean {
  const probe = realm.document.createElement('canvas').getContext('2d')
  if (!probe) return false
  const before = probe.font
  probe.font = ' 12px monospace'
  if (probe.font !== before) return false
  for (const context of [realm.CanvasRenderingContext2D, realm.OffscreenCanvasRenderingContext2D]) {
    const descriptor = context && Object.getOwnPropertyDescriptor(context.prototype, 'font')
    const set = descriptor?.set
    if (!context || !descriptor || !set) continue
    Object.defineProperty(context.prototype, 'font', {
      ...descriptor,
      set(this: unknown, value: unknown) {
        set.call(this, typeof value === 'string' ? value.trim() : value)
      },
    })
  }
  return true
}
