/**
 * Colours for code from a terminal's palette. A palette is made for a terminal, and some of its
 * colours are loud or dark there (Campbell's blue is #0037da): code keeps their hue, with a lightness
 * that reads well on the theme's background and no more colour than an editor's theme has. Calm
 * palettes (Tokyo Night, Catppuccin) stay almost as they are.
 */

interface Bounds {
  /** Lightness (OKLab, 0–1) the colours lie between. */
  minL: number
  maxL: number
  /** The most chroma (OKLCH) a colour keeps. */
  maxC: number
}

/** Like One Dark on a dark background, like GitHub's light theme on a light one. */
const DARK: Bounds = { minL: 0.7, maxL: 0.9, maxC: 0.14 }
const LIGHT: Bounds = { minL: 0.38, maxL: 0.52, maxC: 0.16 }
/** The least contrast (WCAG) to the background, as for text. */
const MIN_CONTRAST = 4.5

type Lab = [number, number, number]
type Rgb = [number, number, number]

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const fromLinear = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join('') : match[1]
  return [0, 2, 4].map((i) => toLinear(parseInt(digits.slice(i, i + 2), 16) / 255)) as Rgb
}

function toHex(rgb: Rgb): string {
  return `#${rgb
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, fromLinear(c))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/** Linear sRGB to OKLab (Björn Ottosson). */
function toOklab([r, g, b]: Rgb): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function fromOklab([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

const inGamut = (rgb: Rgb) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4)
const clamp01 = (rgb: Rgb) => rgb.map((c) => Math.min(1, Math.max(0, c))) as Rgb

/** WCAG's relative luminance, from linear sRGB. */
const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** WCAG's contrast of two colours, 1 to 21. */
function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(clamp01(a)), luminance(clamp01(b))].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** The colour of `lightness` and `hue` with as much chroma as it may keep: at most `max`, and on screen. */
function withChroma(lightness: number, hue: number, max: number): Rgb {
  const at = (c: number) => fromOklab([lightness, c * Math.cos(hue), c * Math.sin(hue)])
  if (inGamut(at(max))) return at(max)
  // The most chroma that is still on screen, to within a hair.
  let low = 0
  let high = max
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2
    if (inGamut(at(mid))) low = mid
    else high = mid
  }
  return at(low)
}

/**
 * `hex` for code on `background`: its hue, with its lightness and chroma brought within calm bounds
 * for a dark or a light background, then lighter (or darker) until it reads as text on it. Anything
 * but `#rgb` or `#rrggbb` comes back as it is.
 */
export function codeColor(hex: string, background: string): string {
  const rgb = parseHex(hex)
  const back = parseHex(background)
  if (!rgb || !back) return hex
  const dark = toOklab(back)[0] < 0.6
  const bounds = dark ? DARK : LIGHT
  const [L, a, b] = toOklab(rgb)
  const hue = Math.atan2(b, a)
  const maxC = Math.min(Math.hypot(a, b), bounds.maxC)
  let lightness = Math.min(bounds.maxL, Math.max(bounds.minL, L))
  let color = withChroma(lightness, hue, maxC)
  // A background far from black or white (Nord's) needs more distance.
  for (let i = 0; i < 40 && contrast(color, back) < MIN_CONTRAST; i++) {
    lightness += dark ? 0.01 : -0.01
    if (lightness <= 0 || lightness >= 1) break
    color = withChroma(lightness, hue, maxC)
  }
  return toHex(color)
}
