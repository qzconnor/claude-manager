import { isPlainObject } from '../utils'
import { baseTheme } from './builtin'
import { formatColor, isLight, parseColor } from './colors'
import type { AppTheme, TerminalPalette, ThemeColors, ThemeContent } from './types'

/** Marks a theme file of the app. */
export const THEME_FILE_FORMAT = 'claude-manager-theme'
/** Raised only when an older app could no longer read the file. */
export const THEME_FILE_VERSION = 1
/** Ids of the themes in files start with it, so they never clash with a built-in theme. */
export const CUSTOM_THEME_PREFIX = 'custom:'
/** A theme file is a few KB; anything far bigger isn't one. */
export const MAX_THEME_FILE_BYTES = 256 * 1024
/** Longer names are cut. */
export const MAX_THEME_NAME_LENGTH = 60

export const APP_COLOR_KEYS = [
  'background',
  'foreground',
  'mutedForeground',
  'surface',
  'popover',
  'primary',
  'primaryForeground',
  'destructive',
  'success',
  'warning',
] as const satisfies readonly (keyof ThemeColors)[]

export const TERMINAL_BASE_KEYS = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
] as const satisfies readonly (keyof TerminalPalette)[]

/** The eight ANSI colors, in the order of their numbers (0–7, bright 8–15). */
export const ANSI_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const
export type AnsiColor = (typeof ANSI_COLORS)[number]

/** A color of a theme by its path in the file, e.g. `app.primary` or `terminal.bright.red`. */
export type ThemeColorKey =
  | `app.${(typeof APP_COLOR_KEYS)[number]}`
  | `terminal.${(typeof TERMINAL_BASE_KEYS)[number]}`
  | `terminal.normal.${AnsiColor}`
  | `terminal.bright.${AnsiColor}`

/** Every color of a theme, in the order of the file and the editor. */
export const THEME_COLOR_KEYS: readonly ThemeColorKey[] = [
  ...APP_COLOR_KEYS.map((key) => `app.${key}` as const),
  ...TERMINAL_BASE_KEYS.map((key) => `terminal.${key}` as const),
  ...ANSI_COLORS.map((color) => `terminal.normal.${color}` as const),
  ...ANSI_COLORS.map((color) => `terminal.bright.${color}` as const),
]

/** Only the selection may be see-through: it lies over the text. */
export function colorAllowsAlpha(key: ThemeColorKey): boolean {
  return key === 'terminal.selectionBackground'
}

/** A theme file: grouped like the editor, every group in a fixed order. */
export interface ThemeFile {
  format: typeof THEME_FILE_FORMAT
  version: number
  name: string
  mode: AppTheme['mode']
  app: ThemeColors
  terminal: Pick<TerminalPalette, (typeof TERMINAL_BASE_KEYS)[number]> & {
    normal: Record<AnsiColor, string>
    bright: Record<AnsiColor, string>
  }
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Where a color of the file lies in a theme. */
function locate(key: ThemeColorKey): { group: 'colors' | 'terminal'; prop: string } {
  const [section, a, b] = key.split('.')
  if (section === 'app') return { group: 'colors', prop: a }
  if (a === 'normal') return { group: 'terminal', prop: b }
  if (a === 'bright') return { group: 'terminal', prop: `bright${capitalize(b)}` }
  return { group: 'terminal', prop: a }
}

export function themeColor(theme: ThemeContent, key: ThemeColorKey): string {
  const { group, prop } = locate(key)
  return (theme[group] as unknown as Record<string, string>)[prop]
}

/** A copy of the theme with one color changed. */
export function withThemeColor<T extends ThemeContent>(theme: T, key: ThemeColorKey, value: string): T {
  const { group, prop } = locate(key)
  return { ...theme, [group]: { ...theme[group], [prop]: value } }
}

/** The theme as its file holds it. */
export function themeToFile(theme: ThemeContent): ThemeFile {
  const t = theme.terminal
  const ansi = (bright: boolean) =>
    Object.fromEntries(ANSI_COLORS.map((color) => [color, t[(bright ? `bright${capitalize(color)}` : color) as keyof TerminalPalette]])) as Record<
      AnsiColor,
      string
    >
  return {
    format: THEME_FILE_FORMAT,
    version: THEME_FILE_VERSION,
    name: theme.name,
    mode: theme.mode,
    app: Object.fromEntries(APP_COLOR_KEYS.map((key) => [key, theme.colors[key]])) as unknown as ThemeColors,
    terminal: {
      ...(Object.fromEntries(TERMINAL_BASE_KEYS.map((key) => [key, t[key]])) as Pick<TerminalPalette, (typeof TERMINAL_BASE_KEYS)[number]>),
      normal: ansi(false),
      bright: ansi(true),
    },
  }
}

/** A theme file that can't be used, with a message for the user. */
export class ThemeFileError extends Error {}

/** The value at the color's path in a parsed file; also the flat form of the app's code (`colors`, `brightRed`). */
function rawColor(data: Record<string, unknown>, key: ThemeColorKey): unknown {
  const [section, a, b] = key.split('.')
  const pick = (object: unknown, prop: string) => (isPlainObject(object) ? object[prop] : undefined)
  if (section === 'app') return pick(data.app, a) ?? pick(data.colors, a)
  const terminal = data.terminal
  if (a === 'normal') return pick(pick(terminal, 'normal'), b) ?? pick(terminal, b)
  if (a === 'bright') return pick(pick(terminal, 'bright'), b) ?? pick(terminal, `bright${capitalize(b)}`)
  return pick(terminal, a)
}

/** At most this many wrong colors are named in the message. */
const NAMED_ERRORS = 3

/**
 * Reads a theme from parsed JSON. Colors the file lacks (e.g. ones newer than the file) come from
 * the built-in theme of its mode; a color that is there but invalid makes the file unusable, with
 * a message that names it. `fallbackName` is used when the file has no name (e.g. its file name).
 */
export function parseThemeFile(data: unknown, fallbackName: string): ThemeContent {
  if (!isPlainObject(data)) throw new ThemeFileError('Die Datei enthält kein Theme.')
  if ('format' in data && data.format !== THEME_FILE_FORMAT) throw new ThemeFileError('Die Datei ist kein Theme des Claude Managers.')
  if (typeof data.version === 'number' && data.version > THEME_FILE_VERSION) {
    throw new ThemeFileError('Das Theme stammt aus einer neueren Version des Claude Managers. Bitte zuerst aktualisieren.')
  }
  if (!('format' in data) && !isPlainObject(data.app) && !isPlainObject(data.colors) && !isPlainObject(data.terminal)) {
    throw new ThemeFileError('Die Datei enthält kein Theme.')
  }

  const colors = new Map<ThemeColorKey, string>()
  const errors: string[] = []
  for (const key of THEME_COLOR_KEYS) {
    const raw = rawColor(data, key)
    if (raw === undefined || raw === null) continue
    const color = typeof raw === 'string' ? parseColor(raw) : null
    if (!color || (color.a < 1 && !colorAllowsAlpha(key))) {
      errors.push(`${key} (${JSON.stringify(raw)})`)
      continue
    }
    colors.set(key, formatColor(color))
  }
  if (errors.length) {
    const named = errors.slice(0, NAMED_ERRORS).join(', ')
    const more = errors.length > NAMED_ERRORS ? ` und ${errors.length - NAMED_ERRORS} weitere` : ''
    throw new ThemeFileError(
      `${errors.length === 1 ? 'Ungültige Farbe' : 'Ungültige Farben'}: ${named}${more}. Erlaubt sind #rrggbb, #rgb und rgb(…)${
        errors.some((e) => e.startsWith('terminal.selectionBackground')) ? ', für die Auswahl auch rgba(…) und #rrggbbaa' : ''
      }.`,
    )
  }

  const background = colors.get('app.background')
  const mode: AppTheme['mode'] =
    data.mode === 'dark' || data.mode === 'light' ? data.mode : background && !isLight(parseColor(background)!) ? 'dark' : background ? 'light' : 'dark'
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallbackName.trim() || 'Eigenes Theme'

  const base = baseTheme(mode)
  let theme: ThemeContent = { name: name.slice(0, MAX_THEME_NAME_LENGTH), mode, colors: { ...base.colors }, terminal: { ...base.terminal } }
  for (const [key, value] of colors) theme = withThemeColor(theme, key, value)
  return theme
}

/** Windows doesn't allow files of these names, whatever their extension. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/

/** A file name (without `.json`) for a theme of this name: lower case letters, digits and dashes. */
export function themeSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '')
  if (!slug) return 'theme'
  return RESERVED_NAMES.test(slug) ? `${slug}-theme` : slug
}

/** `base`, or with `-2`, `-3` … the first one not `taken` (compared without case, like Windows does). */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()))
  if (!lower.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const next = `${base}-${n}`
    if (!lower.has(next.toLowerCase())) return next
  }
}

/** `name`, or with ` 2`, ` 3` … the first one no other theme has (compared without case). */
export function uniqueThemeName(name: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((t) => t.trim().toLowerCase()))
  const trimmed = name.trim().slice(0, MAX_THEME_NAME_LENGTH) || 'Eigenes Theme'
  if (!lower.has(trimmed.toLowerCase())) return trimmed
  for (let n = 2; ; n++) {
    const next = `${trimmed.slice(0, MAX_THEME_NAME_LENGTH - String(n).length - 1)} ${n}`
    if (!lower.has(next.toLowerCase())) return next
  }
}

export const customThemeId = (stem: string) => `${CUSTOM_THEME_PREFIX}${stem}`

/** The file name (without `.json`) of a custom theme's id; null for a built-in id. */
export function customThemeStem(id: string | null | undefined): string | null {
  return id?.startsWith(CUSTOM_THEME_PREFIX) ? id.slice(CUSTOM_THEME_PREFIX.length) || null : null
}

/** The colors of `theme` in another theme's place: a copy for editing, without the id. */
export function themeContent({ name, mode, colors, terminal }: ThemeContent): ThemeContent {
  return { name, mode, colors: { ...colors }, terminal: { ...terminal } }
}
