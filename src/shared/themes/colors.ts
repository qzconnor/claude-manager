/** A color with channels from 0 to 255 and alpha from 0 to 1. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** Hue from 0 to 360, saturation and value from 0 to 1. */
export interface Hsv {
  h: number
  s: number
  v: number
}

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i

/**
 * A color written as `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` or `rgba(r, g, b, a)`;
 * null for anything else (also channels above 255 or alpha above 1).
 */
export function parseColor(value: string): Rgba | null {
  const text = value.trim()
  const hex = HEX_RE.exec(text)
  if (hex) {
    const short = hex[1].length <= 4
    const digits = short ? [...hex[1]].map((d) => d + d).join('') : hex[1]
    const channel = (i: number) => parseInt(digits.slice(i * 2, i * 2 + 2), 16)
    return { r: channel(0), g: channel(1), b: channel(2), a: digits.length === 8 ? round(channel(3) / 255) : 1 }
  }
  const rgb = RGB_RE.exec(text)
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number)
    const a = rgb[4] === undefined ? 1 : Number(rgb[4])
    if (r > 255 || g > 255 || b > 255 || a > 1) return null
    return { r, g, b, a: round(a) }
  }
  return null
}

/** `#rrggbb`, lower case; alpha left out. */
export function toHex({ r, g, b }: Rgba): string {
  return `#${[r, g, b].map((c) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, '0')).join('')}`
}

/** As the themes write a color: `#rrggbb` when opaque, else `rgba(r, g, b, a)`. */
export function formatColor(color: Rgba): string {
  if (color.a >= 1) return toHex(color)
  const [r, g, b] = [color.r, color.g, color.b].map((c) => Math.round(clamp(c, 0, 255)))
  return `rgba(${r}, ${g}, ${b}, ${round(clamp(color.a, 0, 1))})`
}

/** The color in the form `formatColor` writes; null when it isn't one. */
export function normalizeColor(value: string): string | null {
  const color = parseColor(value)
  return color ? formatColor(color) : null
}

export function rgbToHsv({ r, g, b }: Rgba): Hsv {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255]
  const max = Math.max(rn, gn, bn)
  const delta = max - Math.min(rn, gn, bn)
  let h = 0
  if (delta > 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6
    else if (max === gn) h = (bn - rn) / delta + 2
    else h = (rn - gn) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max }
}

export function hsvToRgb({ h, s, v }: Hsv, a = 1): Rgba {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
  }
  return { r: f(5), g: f(3), b: f(1), a }
}

/** Relative luminance (WCAG) of the color, alpha left out. */
export function luminance({ r, g, b }: Rgba): number {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

/** Contrast ratio (WCAG) of two colors, from 1 to 21. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/** Whether text in this color would be read on a dark background, i.e. the color is light. */
export function isLight(color: Rgba): boolean {
  return luminance(color) > 0.18
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const round = (value: number) => Math.round(value * 100) / 100
