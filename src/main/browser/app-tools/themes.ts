import { baseTheme, THEMES } from '@shared/themes/builtin'
import { contrastIssues, suggestedMode } from '@shared/themes/checks'
import { formatColor, isLight, parseColor } from '@shared/themes/colors'
import {
  ANSI_COLORS,
  colorAllowsAlpha,
  customThemeStem,
  MAX_THEME_NAME_LENGTH,
  THEME_COLOR_KEYS,
  themeColor,
  themeContent,
  withThemeColor,
  type ThemeColorKey,
} from '@shared/themes/file'
import type { AppTheme, ThemeContent } from '@shared/themes/types'
import { isPlainObject } from '@shared/utils'
import { type Args, oneOf, optionalBoolean, optionalString, requiredString, ToolError } from '../tool-args'
import { type AppToolDefinition, type AppToolsDeps, tool } from './tool'

/**
 * The tools themes_list, theme_create, theme_update and theme_apply: the user's own color themes,
 * the same files the theme editor writes. Only when the user asks: the descriptions say so, and
 * Claude Code asks before each change (`askFirst`), whatever the settings allow.
 */

/** What each color is for, as the theme editor explains it. */
const COLOR_USES: Record<string, string> = {
  'app.background': 'Window and sidebar; tints the see-through window material.',
  'app.foreground': 'Text and icons; borders and hover areas are mixed from it.',
  'app.mutedForeground': 'Descriptions, placeholders, times, inactive tabs.',
  'app.surface': 'Cards, settings sections, tab bars, file tree.',
  'app.popover': 'Opaque menus, tooltips, dialogs, command palette.',
  'app.primary': "Accent: main buttons, selection, focus rings, switches, Claude Code's crab.",
  'app.primaryForeground': 'Text and icons on the accent.',
  'app.destructive': 'Delete buttons, errors, limits from 85 %.',
  'app.success': 'Confirmations, activity dots, limits below 60 %.',
  'app.warning': 'Hints, sessions waiting for the user, search hits.',
  'terminal.background': "Behind terminals and the code view; Claude Code's theme Auto picks light or dark by it.",
  'terminal.foreground': 'Normal output.',
  'terminal.cursor': 'The cursor.',
  'terminal.cursorAccent': 'The character under a block cursor.',
  'terminal.selectionBackground': 'Behind selected text; may be see-through (rgba(…) or #rrggbbaa).',
}

function colorUse(key: ThemeColorKey): string {
  const [, group, color] = key.split('.')
  if (group === 'normal' || group === 'bright') {
    return `ANSI color ${ANSI_COLORS.indexOf(color as never) + (group === 'bright' ? 8 : 0)} (${group === 'bright' ? 'bright ' : ''}${color}).`
  }
  return COLOR_USES[key]
}

const COLORS_PROPERTY = {
  type: 'object',
  description:
    'Colors by their path in the theme file, as #rrggbb, #rgb or rgb(…); only terminal.selectionBackground may be see-through. Colors left out come from the base theme.',
  properties: Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, { type: 'string', description: colorUse(key) }])),
  additionalProperties: false,
}

const APPLY_PROPERTY = {
  type: 'boolean',
  description: "true: the app uses the theme right away (when the user wants to see or use it). The result names the theme before, to switch back with theme_apply.",
}

const ONLY_WHEN_ASKED = 'Only when the user asks for it, never on your own.'

export const themeTools: AppToolDefinition<never>[] = [
  tool({
    name: 'themes_list',
    title: 'List color themes',
    description:
      "The color themes of Claude Manager: the built-in ones, the user's own (files the theme editor writes) and the one in use. With id, all colors of that theme, e.g. to start a new theme from it.",
    properties: {
      id: { type: 'string', description: 'A theme whose colors to show.' },
    },
    group: 'themes',
    readOnly: true,
    parse: (args) => ({ id: optionalString(args, 'id', 200)?.trim() || undefined }),
    run: async (app, _session, p) => (p.id ? describeTheme(app.deps, p.id) : listThemes(app.deps)),
  }),
  tool({
    name: 'theme_create',
    title: 'Create a color theme',
    description: `Creates a color theme of the user's own for the whole app (windows, menus, terminals), as the theme editor does. ${ONLY_WHEN_ASKED} Start from a theme close to what the user wants (base) and give the colors that differ. The result points out text with too little contrast.`,
    properties: {
      name: { type: 'string', description: `The theme's name (up to ${MAX_THEME_NAME_LENGTH} characters); a name in use gets a number.` },
      mode: { type: 'string', enum: ['dark', 'light'], description: 'Dark or light; by default as the background is.' },
      base: { type: 'string', description: 'The theme whose colors fill in the ones not given (id from themes_list); by default Ember for dark, Paper for light.' },
      colors: COLORS_PROPERTY,
      apply: APPLY_PROPERTY,
    },
    required: ['name'],
    group: 'themes',
    askFirst: true,
    parse: parseCreate,
    run: async (app, _session, p) => createTheme(app.deps, p),
  }),
  tool({
    name: 'theme_update',
    title: 'Change a color theme',
    description: `Changes one of the user's own themes: its name, mode or some of its colors; the rest stays. ${ONLY_WHEN_ASKED} Built-in themes can't be changed: create a theme with one as base instead.`,
    properties: {
      id: { type: 'string', description: "The theme (an id starting with custom:, from themes_list or theme_create)." },
      name: { type: 'string', description: 'A new name; the theme gets a new id, and settings that use it follow.' },
      mode: { type: 'string', enum: ['dark', 'light'], description: 'Dark or light.' },
      colors: COLORS_PROPERTY,
      apply: APPLY_PROPERTY,
    },
    required: ['id'],
    group: 'themes',
    askFirst: true,
    destructive: true,
    parse: parseUpdate,
    run: async (app, _session, p) => updateTheme(app.deps, p),
  }),
  tool({
    name: 'theme_apply',
    title: 'Use a color theme',
    description: `The app uses this theme (built-in or the user's own) from now on, e.g. to switch back after trying one. ${ONLY_WHEN_ASKED}`,
    properties: {
      id: { type: 'string', description: 'The theme (id from themes_list).' },
    },
    required: ['id'],
    group: 'themes',
    askFirst: true,
    parse: (args) => ({ id: requiredString(args, 'id', 200).trim() }),
    run: async (app, _session, p) => applyTheme(app.deps, await findTheme(app.deps, p.id)),
  }),
]

export interface CreateParams {
  name: string
  mode: AppTheme['mode'] | undefined
  base: string | undefined
  colors: Map<ThemeColorKey, string>
  apply: boolean
}

export interface UpdateParams {
  id: string
  name: string | undefined
  mode: AppTheme['mode'] | undefined
  colors: Map<ThemeColorKey, string>
  apply: boolean
}

function parseName(args: Args, required: boolean): string | undefined {
  const name = required ? requiredString(args, 'name', 200) : optionalString(args, 'name', 200)
  if (name === undefined) return undefined
  const trimmed = name.trim()
  if (!trimmed) throw new ToolError('name must not be empty.')
  if (trimmed.length > MAX_THEME_NAME_LENGTH) throw new ToolError(`name takes at most ${MAX_THEME_NAME_LENGTH} characters.`)
  return trimmed
}

function parseMode(args: Args): AppTheme['mode'] | undefined {
  return args.mode === undefined || args.mode === null ? undefined : oneOf(args, 'mode', ['dark', 'light'] as const)
}

/** The colors given, written as the theme files write them; every wrong one is named. */
export function parseColors(args: Args): Map<ThemeColorKey, string> {
  const value = args.colors
  const colors = new Map<ThemeColorKey, string>()
  if (value === undefined || value === null) return colors
  if (!isPlainObject(value)) throw new ToolError('colors must be an object of color paths and colors, e.g. {"app.primary": "#4f8cff"}.')
  const keys = new Set<string>(THEME_COLOR_KEYS)
  const unknown = Object.keys(value).filter((key) => !keys.has(key))
  if (unknown.length) {
    throw new ToolError(`Unknown colors: ${unknown.join(', ')}. The colors are ${THEME_COLOR_KEYS.join(', ')}.`)
  }
  const wrong: string[] = []
  for (const [key, raw] of Object.entries(value) as [ThemeColorKey, unknown][]) {
    const color = typeof raw === 'string' ? parseColor(raw) : null
    if (!color || (color.a < 1 && !colorAllowsAlpha(key))) wrong.push(`${key} (${JSON.stringify(raw)})`)
    else colors.set(key, formatColor(color))
  }
  if (wrong.length) {
    throw new ToolError(`Invalid colors: ${wrong.join(', ')}. Use #rrggbb, #rgb or rgb(r, g, b); only terminal.selectionBackground may be see-through.`)
  }
  return colors
}

function parseCreate(args: Args): CreateParams {
  return {
    name: parseName(args, true)!,
    mode: parseMode(args),
    base: optionalString(args, 'base', 200)?.trim() || undefined,
    colors: parseColors(args),
    apply: optionalBoolean(args, 'apply') ?? false,
  }
}

function parseUpdate(args: Args): UpdateParams {
  const params: UpdateParams = {
    id: requiredString(args, 'id', 200).trim(),
    name: parseName(args, false),
    mode: parseMode(args),
    colors: parseColors(args),
    apply: optionalBoolean(args, 'apply') ?? false,
  }
  if (params.name === undefined && params.mode === undefined && params.colors.size === 0) {
    throw new ToolError(params.apply ? 'To only use the theme, call theme_apply.' : 'Give name, mode or colors to change.')
  }
  return params
}

/** The theme with these colors changed. */
function withColors(theme: ThemeContent, colors: Map<ThemeColorKey, string>): ThemeContent {
  let next = theme
  for (const [key, value] of colors) next = withThemeColor(next, key, value)
  return next
}

/** The mode of a new theme: as given, else as its background is. */
export function newThemeMode(mode: AppTheme['mode'] | undefined, colors: Map<ThemeColorKey, string>, base: AppTheme | null): AppTheme['mode'] {
  if (mode) return mode
  const background = colors.get('app.background')
  if (background) return isLight(parseColor(background)!) ? 'light' : 'dark'
  return base?.mode ?? 'dark'
}

/** The colors of a new theme: those of `base` (or the built-in theme of its mode), with the ones given. */
export function buildTheme(p: CreateParams, base: AppTheme | null): ThemeContent {
  const mode = newThemeMode(p.mode, p.colors, base)
  const start = themeContent(base ?? baseTheme(mode))
  return withColors({ ...start, name: p.name, mode }, p.colors)
}

/** A theme by id, built-in or the user's own; an error that names the ids otherwise. */
async function findTheme(deps: AppToolsDeps, id: string): Promise<AppTheme> {
  const builtIn = THEMES.find((t) => t.id === id)
  if (builtIn) return builtIn
  const entry = (await deps.themes.list()).find((e) => e.id === id)
  if (entry?.theme) return entry.theme
  if (entry) throw new ToolError(`The theme file ${entry.file} can't be used: ${entry.error}`)
  throw new ToolError(`There is no theme ${JSON.stringify(id)}. Call themes_list for the ids.`)
}

const label = (theme: Pick<AppTheme, 'id' | 'name'>) => `"${theme.name}" (${theme.id})`

/** themes_list without id: every theme, and which ones are in use. */
export async function listThemes(deps: AppToolsDeps): Promise<string> {
  const entries = await deps.themes.list()
  const all = [...THEMES, ...entries.flatMap((e) => (e.theme ? [e.theme] : []))]
  const { appearance, terminal } = deps.settings.get()
  const lines = [inUse(all, appearance.themeId, terminal.colorSchemeId), '', 'Built-in themes (can be a base, but not changed):']
  for (const theme of THEMES) lines.push(`- ${label(theme)}, ${theme.mode}`)
  lines.push('', `The user's own themes (files in ${deps.themes.dir}):`)
  if (entries.length === 0) lines.push('- none yet')
  for (const entry of entries) {
    lines.push(entry.theme ? `- ${label(entry.theme)}, ${entry.theme.mode}` : `- ${entry.file}: can't be used: ${entry.error}`)
  }
  return lines.join('\n')
}

function inUse(all: readonly AppTheme[], themeId: string, schemeId: string | null): string {
  const name = (id: string) => {
    const theme = all.find((t) => t.id === id)
    return theme ? label(theme) : `${id} (missing, the default theme shows)`
  }
  const scheme = schemeId === null ? 'the terminals follow it' : `the terminals use their own scheme ${name(schemeId)} (Einstellungen › Terminal)`
  return `In use: ${name(themeId)}; ${scheme}.`
}

/** themes_list with id: the theme's colors, in the paths theme_create and theme_update take. */
export async function describeTheme(deps: AppToolsDeps, id: string): Promise<string> {
  const theme = await findTheme(deps, id)
  const colors = Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, themeColor(theme, key)]))
  const kind = customThemeStem(theme.id) ? "one of the user's own" : 'built-in'
  return `${label(theme)}, ${theme.mode}, ${kind}. Colors:\n${JSON.stringify(colors, null, 2)}`
}

/** What the result says about the theme's contrast and mode. */
export function checksText(theme: ThemeContent): string {
  const issues = contrastIssues(theme).map((i) => `${i.key} on ${i.against} has a contrast of ${i.ratio.toFixed(1)}:1, at least ${i.min}:1 is needed`)
  const mode = suggestedMode(theme)
  if (mode) issues.push(`the text is ${mode === 'dark' ? 'lighter' : 'darker'} than the background, so mode should be ${mode}`)
  return issues.length ? `To check: ${issues.join('; ')}. Fix it with theme_update.` : 'Contrast and mode are fine.'
}

export async function createTheme(deps: AppToolsDeps, p: CreateParams): Promise<string> {
  const base = p.base ? await findTheme(deps, p.base) : null
  const entry = await deps.themes.create(buildTheme(p, base))
  const theme = entry.theme!
  const lines = [`Created ${label(theme)}, ${theme.mode}${base ? `, based on ${label(base)}` : ''}, in ${entry.file}.`, checksText(theme)]
  lines.push(p.apply ? await applyTheme(deps, theme) : notInUse())
  return lines.join('\n')
}

export async function updateTheme(deps: AppToolsDeps, p: UpdateParams): Promise<string> {
  if (!customThemeStem(p.id)) {
    throw new ToolError(`${p.id} is a built-in theme and can't be changed. Create a theme with base ${JSON.stringify(p.id)} instead.`)
  }
  const before = await findTheme(deps, p.id)
  const changed = withColors({ ...themeContent(before), name: p.name ?? before.name, mode: p.mode ?? before.mode }, p.colors)
  const entry = await deps.themes.save(p.id, changed)
  const theme = entry.theme!
  const lines = [`Saved ${label(theme)}, ${theme.mode}.`]
  if (entry.id !== p.id) {
    await follow(deps, p.id, entry.id)
    lines.push(`With the new name its id is ${entry.id} now (was ${p.id}).`)
  }
  lines.push(checksText(theme))
  const { appearance } = deps.settings.get()
  if (p.apply && appearance.themeId !== theme.id) lines.push(await applyTheme(deps, theme))
  else if (appearance.themeId === theme.id) lines.push('It is the theme in use: the app shows the change at once.')
  else lines.push(notInUse())
  return lines.join('\n')
}

/** Settings that chose the theme `from` take `to`, as after a rename in the theme editor. */
async function follow(deps: AppToolsDeps, from: string, to: string): Promise<void> {
  const { appearance, terminal } = deps.settings.get()
  if (appearance.themeId === from) await deps.settings.update({ appearance: { themeId: to } })
  if (terminal.colorSchemeId === from) await deps.settings.update({ terminal: { colorSchemeId: to } })
}

function notInUse(): string {
  return 'Not in use: theme_apply uses it, or the user picks it in Einstellungen › Darstellung, where the theme editor changes it too.'
}

/** theme_apply: the app's theme from now on; names the one before, to switch back. */
export async function applyTheme(deps: AppToolsDeps, theme: AppTheme): Promise<string> {
  const { appearance, terminal } = deps.settings.get()
  const previous = appearance.themeId
  if (previous === theme.id) return `${label(theme)} is already the theme in use.`
  await deps.settings.update({ appearance: { themeId: theme.id } })
  const before = THEMES.find((t) => t.id === previous) ?? (await deps.themes.list()).find((e) => e.id === previous)?.theme
  const lines = [`The app uses ${label(theme)} now (before: ${before ? label(before) : previous}).`]
  if (terminal.colorSchemeId !== null && terminal.colorSchemeId !== theme.id) {
    lines.push(`The terminals keep their own color scheme ${terminal.colorSchemeId}; the user changes that in Einstellungen › Terminal.`)
  }
  return lines.join(' ')
}
