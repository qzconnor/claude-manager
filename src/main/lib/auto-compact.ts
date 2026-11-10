import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson } from './json-file'

/**
 * Where Claude Code compacts a conversation by itself, mirrored from 2.1.x:
 * - The window is, in this order: `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, the setting `autoCompactWindow`
 *   of the model in `modelSettings` (what `/autocompact` writes), the top-level `autoCompactWindow`,
 *   otherwise ("auto") the model's context window. Never more than the context window.
 * - It compacts at the window less room for the answer (the model's output, at most 20k) and for
 *   the summary (13k): at 167k of a 200k window. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can lower that.
 * - `autoCompactEnabled: false`, `DISABLE_AUTO_COMPACT` or `DISABLE_COMPACT` turn it off.
 * Windows the server sets for an account or an experiment aren't in a file: there "auto" stays a guess.
 */

const SUMMARY_BUFFER = 13_000
const MAX_ANSWER_BUFFER = 20_000
const DEFAULT_WINDOW = 200_000
const ONE_MILLION = 1_000_000
/** What `/autocompact` takes. */
const MIN_WINDOW = 100_000
/** Settings and the model catalog are read again after this long. */
const CACHE_MS = 5_000

export interface CompactLimit {
  /** The model it is for: the session's, before its first answer the one chosen in Claude Code; null when unknown. */
  model: string | null
  /** The auto-compact window: set with `/autocompact` (or the setting), otherwise the model's context window. */
  window: number
  /** The window was set, not the model's own. */
  configured: boolean
  /** Where Claude Code compacts by itself; null when auto-compact is off. */
  compactAt: number | null
}

interface Settings {
  model?: unknown
  autoCompactEnabled?: unknown
  autoCompactWindow?: unknown
  modelSettings?: Record<string, { autoCompactWindow?: unknown } | undefined>
  env?: Record<string, unknown>
}

interface CatalogModel {
  id?: unknown
  runtime?: { max_input_tokens?: unknown; max_output_tokens?: unknown }
}

export interface AccountFiles {
  settings: Settings
  /** Context window and output limit by model, from Claude Code's model catalog. */
  models: Map<string, { input: number | null; output: number | null }>
  /** The model chosen in Claude Code (`/model`), as the catalog names it, e.g. `claude-opus-5-5` for `opus`. */
  selected: string | null
}

const cache = new Map<string, { at: number; files: Promise<AccountFiles> }>()

/**
 * Where Claude Code compacts the conversation of `model` for the account with `configDir`; without a
 * model (before the first answer) for the one chosen in Claude Code.
 */
export async function readCompactLimit(configDir: string, model: string | null, env: NodeJS.ProcessEnv = process.env): Promise<CompactLimit> {
  return compactLimit(await accountFiles(configDir), model, env)
}

export function compactLimit(files: AccountFiles, session: string | null, env: NodeJS.ProcessEnv): CompactLimit {
  const { settings } = files
  const model = session ?? files.selected
  const variable = (name: string): string | undefined => {
    const value = env[name] ?? settings.env?.[name]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  const known = model ? findModel(files.models, model) : undefined
  const settingModel = typeof settings.model === 'string' ? settings.model : ''
  const context = Math.max(known?.input ?? DEFAULT_WINDOW, /\[1m\]/i.test(settingModel) ? ONE_MILLION : 0)

  const set =
    tokens(variable('CLAUDE_CODE_AUTO_COMPACT_WINDOW')) ??
    tokens(model ? modelSetting(settings.modelSettings, model) : undefined) ??
    tokens(settings.autoCompactWindow)
  const window = set === undefined ? context : Math.min(context, Math.max(MIN_WINDOW, set))

  const off =
    settings.autoCompactEnabled === false || truthy(variable('DISABLE_AUTO_COMPACT')) || truthy(variable('DISABLE_COMPACT'))
  if (off) return { model, window, configured: set !== undefined, compactAt: null }
  const usable = window - Math.min(known?.output ?? MAX_ANSWER_BUFFER, MAX_ANSWER_BUFFER)
  let compactAt = usable - SUMMARY_BUFFER
  const percent = Number(variable('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'))
  if (percent > 0 && percent <= 100) compactAt = Math.min(Math.floor((usable * percent) / 100), compactAt)
  return { model, window, configured: set !== undefined, compactAt }
}

/** A number of tokens, also written as `400k` or `1m`; undefined for `auto` and anything else. */
function tokens(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
  if (typeof value !== 'string') return undefined
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(value.trim())
  if (!match) return undefined
  const unit = match[2].toLowerCase()
  const amount = Number(match[1]) * (unit === 'm' ? ONE_MILLION : unit === 'k' ? 1000 : 1)
  return amount > 0 ? Math.round(amount) : undefined
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

/** A model's entry: the same id, or one without the date (`claude-haiku-4-5` for `claude-haiku-4-5-20251001`). */
function matches(key: string, model: string): boolean {
  const a = key.toLowerCase()
  const b = model.toLowerCase().replace(/\[1m\]$/, '')
  return a === b || b.startsWith(`${a}-`)
}

function modelSetting(entries: Settings['modelSettings'], model: string): unknown {
  if (!entries || typeof entries !== 'object') return undefined
  const exact = entries[model]?.autoCompactWindow
  if (exact !== undefined) return exact
  for (const [key, entry] of Object.entries(entries)) {
    if (matches(key, model) && entry?.autoCompactWindow !== undefined) return entry.autoCompactWindow
  }
  return undefined
}

function findModel(models: AccountFiles['models'], model: string): { input: number | null; output: number | null } | undefined {
  const exact = models.get(model.toLowerCase())
  if (exact) return exact
  for (const [id, info] of models) if (matches(id, model)) return info
  return undefined
}

function accountFiles(configDir: string): Promise<AccountFiles> {
  const now = Date.now()
  const cached = cache.get(configDir)
  if (cached && now - cached.at < CACHE_MS) return cached.files
  const files = loadAccountFiles(configDir)
  cache.set(configDir, { at: now, files })
  return files
}

async function loadAccountFiles(configDir: string): Promise<AccountFiles> {
  const settings = (await readJson<Settings>(join(configDir, 'settings.json'))) ?? {}
  return { settings: typeof settings === 'object' && settings ? settings : {}, ...(await readCatalog(configDir)) }
}

/** Claude Code's model catalog (`cache/model-catalog/*-cc.json`), the newest file first. */
async function readCatalog(configDir: string): Promise<Pick<AccountFiles, 'models' | 'selected'>> {
  const models: AccountFiles['models'] = new Map()
  let selected: string | null = null
  const dir = join(configDir, 'cache', 'model-catalog')
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('-cc.json'))
  const dated = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })),
  )
  for (const { name } of dated.sort((a, b) => b.mtime - a.mtime)) {
    const file = await readJson<{ catalog?: { config?: { models?: unknown }; state?: { model?: unknown } } }>(join(dir, name))
    const chosen = file?.catalog?.state?.model
    if (selected === null && typeof chosen === 'string' && chosen) selected = chosen
    const list = file?.catalog?.config?.models
    if (!Array.isArray(list)) continue
    for (const entry of list as CatalogModel[]) {
      if (typeof entry?.id !== 'string' || models.has(entry.id.toLowerCase())) continue
      const input = entry.runtime?.max_input_tokens
      const output = entry.runtime?.max_output_tokens
      models.set(entry.id.toLowerCase(), {
        input: typeof input === 'number' && input > 0 ? input : null,
        output: typeof output === 'number' && output > 0 ? output : null,
      })
    }
  }
  return { models, selected }
}
