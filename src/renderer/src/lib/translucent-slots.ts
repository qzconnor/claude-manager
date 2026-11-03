import type { WebglAddon } from '@xterm/addon-webgl'
import { parseHex, SLOT_NAMES, SLOTS, type SlotTints } from './claude-backgrounds'

/**
 * xterm draws every cell background opaque. The palette slots that stand for Claude's backgrounds
 * (see claude-backgrounds.ts) are drawn see-through instead, so the window material shines through
 * them: in the WebGL renderer by a patch of its rectangle renderer, in the DOM renderer by a style
 * sheet. The xterm theme keeps an opaque version of each slot for the glyphs and the contrast.
 */

// xterm's cell attributes (common/buffer/Constants.ts).
const FG_INVERSE = 0x4000000
const COLOR_MODE_MASK = 0x3000000
const COLOR_MODE_P256 = 0x2000000

/** Slot index → `[r, g, b, a]` as the WebGL vertices take them. */
const webglColors = new Map<number, Float32Array>()
let domStyle: HTMLStyleElement | null = null

/** Sets the see-through colors of the slots, for every terminal. */
export function setSlotTints(tints: SlotTints): void {
  webglColors.clear()
  const rules: string[] = []
  for (const slot of SLOT_NAMES) {
    const rgb = parseHex(tints[slot].color)
    if (!rgb) continue
    const { alpha } = tints[slot]
    // xterm blends with SRC_ALPHA, ONE_MINUS_SRC_ALPHA onto an empty frame, which leaves rgb·a and
    // a² there. The canvas counts as premultiplied, so the frame must hold rgb·a and a: √a for the
    // alpha and rgb·√a for the color give exactly that.
    const root = Math.sqrt(alpha)
    webglColors.set(SLOTS[slot], Float32Array.from([...rgb.map((value) => (value / 255) * root), root]))
    rules.push(`.xterm .xterm-bg-${SLOTS[slot]} { background-color: rgba(${rgb.join(', ')}, ${alpha}) !important; }`)
  }
  domStyle ??= document.head.appendChild(document.createElement('style'))
  domStyle.textContent = rules.join('\n')
}

interface Vertices {
  attributes: Float32Array
}

interface RectangleRenderer {
  _gl: WebGL2RenderingContext
  _updateRectangle(vertices: Vertices, offset: number, fg: number, bg: number, startX: number, endX: number, y: number): void
  renderBackgrounds(): void
}

let patched = false

/**
 * Patches the rectangle renderer of xterm's WebGL addon (once, for all terminals) to draw the
 * slots with their alpha. Its parts are private, so every step checks that they are still there;
 * if not, the slots simply stay opaque.
 */
export function makeSlotsTranslucent(addon: WebglAddon): void {
  if (patched) return
  const renderer = (addon as unknown as { _renderer?: { _rectangleRenderer?: { value?: object } } })._renderer
  const instance = renderer?._rectangleRenderer?.value
  if (!instance) return
  const proto = Object.getPrototypeOf(instance) as RectangleRenderer
  const { _updateRectangle: update, renderBackgrounds } = proto
  if (typeof update !== 'function' || typeof renderBackgrounds !== 'function') return
  patched = true

  proto._updateRectangle = function (vertices, offset, fg, bg, startX, endX, y) {
    update.call(this, vertices, offset, fg, bg, startX, endX, y)
    if (fg & FG_INVERSE || (bg & COLOR_MODE_MASK) !== COLOR_MODE_P256) return
    const color = webglColors.get(bg & 0xff)
    // A rectangle is x, y, width, height, r, g, b, a.
    if (color) vertices.attributes.set(color, offset + 4)
  }

  // xterm draws the whole frame every time and leaves clearing the canvas to the browser. An
  // opaque cell drawn twice looks the same, a see-through one would get darker: clear first.
  proto.renderBackgrounds = function () {
    const gl = this._gl
    if (gl) {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    renderBackgrounds.call(this)
  }
}
