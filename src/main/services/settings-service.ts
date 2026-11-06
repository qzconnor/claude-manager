import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createDefaultSettings as sharedDefaults } from '@shared/defaults'
import type { AppSettings, DeepPartial, SettingsImportResult } from '@shared/types'
import { isPlainObject, mergeKnown } from '@shared/utils'
import { readJson, readJsonSync, writeJsonAtomic } from '../lib/json-file'
import { TypedEmitter } from '../lib/typed-emitter'

/** The defaults of this platform (e.g. the terminal font). */
const createDefaultSettings = () => sharedDefaults(process.platform)

type Events = { changed: [settings: AppSettings, previous: AppSettings] }

/** Marks a file with exported settings. */
const EXPORT_FORMAT = 'claude-manager-settings'
/** Raised only when an older app could no longer read the file. */
const EXPORT_VERSION = 1
/** Exported settings are a few KB; anything far bigger isn't such a file. */
const MAX_IMPORT_BYTES = 1024 * 1024

export class SettingsService extends TypedEmitter<Events> {
  private readonly file: string
  private settings: AppSettings

  constructor(userDataDir: string) {
    super()
    this.file = join(userDataDir, 'settings.json')
    this.settings = sanitize(mergeKnown(createDefaultSettings(), migrate(readJsonSync(this.file))))
  }

  get(): AppSettings {
    return structuredClone(this.settings)
  }

  async update(patch: DeepPartial<AppSettings>): Promise<AppSettings> {
    const previous = this.settings
    this.settings = sanitize(mergeKnown(this.settings, patch))
    await writeJsonAtomic(this.file, this.settings)
    this.emit('changed', this.get(), previous)
    return this.get()
  }

  async reset(section?: keyof AppSettings): Promise<AppSettings> {
    const defaults = createDefaultSettings()
    const previous = this.settings
    this.settings = section ? { ...this.settings, [section]: defaults[section] } : defaults
    await writeJsonAtomic(this.file, this.settings)
    this.emit('changed', this.get(), previous)
    return this.get()
  }

  /** Saves the settings to a file, e.g. for another computer. Accounts aren't part of them. */
  async exportTo(file: string, appVersion: string): Promise<void> {
    const settings = this.get() as unknown as Record<string, unknown>
    dropLocal(settings)
    await writeJsonAtomic(file, {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      appVersion,
      exportedAt: new Date().toISOString(),
      settings,
    })
  }

  /**
   * Takes over the settings of an exported file (a settings.json from the data folder works too).
   * Settings the file doesn't have keep their value, e.g. ones newer than the file.
   */
  async importFrom(file: string): Promise<SettingsImportResult> {
    if ((await stat(file)).size > MAX_IMPORT_BYTES) throw new Error('Die Datei ist zu groß für exportierte Einstellungen.')
    const data = await readJson<unknown>(file)
    if (data === null) throw new Error('Die Datei ist kein gültiges JSON.')
    const imported = migrate(settingsIn(data)) as Record<string, unknown>
    dropLocal(imported)
    const skipped = dropMissingPaths(imported)
    return { settings: await this.update(imported as DeepPartial<AppSettings>), skipped }
  }
}

/** The settings in an exported file, or the file itself when it is a settings.json. */
function settingsIn(data: unknown): Record<string, unknown> {
  if (isPlainObject(data)) {
    if (data.format === EXPORT_FORMAT) {
      if (typeof data.version === 'number' && data.version > EXPORT_VERSION) {
        throw new Error('Die Datei stammt aus einer neueren Version des Claude Managers. Bitte zuerst aktualisieren.')
      }
      if (isPlainObject(data.settings)) return data.settings
    } else if (!('format' in data) && Object.keys(createDefaultSettings()).some((key) => isPlainObject(data[key]))) {
      return data
    }
  }
  throw new Error('Die Datei enthält keine Einstellungen des Claude Managers.')
}

/**
 * Leaves out what belongs to this installation: the default account (accounts stay where they
 * are, its id means nothing elsewhere) and whether the question for the default folder was asked.
 */
function dropLocal(settings: Record<string, unknown>): void {
  if (isPlainObject(settings.general)) delete settings.general.defaultAccountId
  if (isPlainObject(settings.claude)) delete settings.claude.defaultCwdAsked
}

/**
 * Leaves out paths of another computer that don't exist here: with a missing claude executable no
 * terminal would start. Returns the names of the settings that keep their value.
 */
function dropMissingPaths(settings: Record<string, unknown>): string[] {
  const claude = settings.claude
  if (!isPlainObject(claude)) return []
  const paths = [
    { key: 'executablePath', label: process.platform === 'win32' ? 'Pfad zur claude.exe' : 'Pfad zu claude', directory: false },
    { key: 'defaultCwd', label: 'Standard-Arbeitsordner', directory: true },
  ]
  const skipped: string[] = []
  for (const { key, label, directory } of paths) {
    const value = claude[key]
    if (typeof value !== 'string' || !value.trim() || exists(value.trim(), directory)) continue
    delete claude[key]
    skipped.push(label)
  }
  return skipped
}

function exists(path: string, directory: boolean): boolean {
  try {
    const stats = statSync(path)
    return directory ? stats.isDirectory() : stats.isFile()
  } catch {
    return false
  }
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Brings a settings file of an older version into the current shape. */
function migrate(stored: unknown): unknown {
  if (!isPlainObject(stored)) return {}
  const terminal = stored.terminal
  // Earlier there was one padding for all sides; on the right at least the scrollbar's 14 px were kept free.
  if (isPlainObject(terminal) && typeof terminal.padding === 'number') {
    const p = terminal.padding
    terminal.padding = { top: p, right: Math.max(p, 14), bottom: p, left: p }
  }
  // The flashing taskbar was a setting of its own before the notifications got their page.
  const general = stored.general
  if (isPlainObject(general) && typeof general.flashOnTurnEnd === 'boolean') {
    const notifications = isPlainObject(stored.notifications) ? stored.notifications : {}
    if (!('flashTaskbar' in notifications)) notifications.flashTaskbar = general.flashOnTurnEnd
    stored.notifications = notifications
    delete general.flashOnTurnEnd
  }
  return stored
}

/** Keeps every numeric setting in a sane range, whatever the settings file contains. */
function sanitize(s: AppSettings): AppSettings {
  const d = createDefaultSettings()
  const materials = ['acrylic', 'mica', 'tabbed', 'none'] as const
  const cursors = ['block', 'bar', 'underline'] as const
  const closeOnExit = ['graceful', 'always', 'never'] as const
  const panelBackgrounds = ['theme', 'terminal', 'original'] as const
  s.appearance.material = materials.includes(s.appearance.material) ? s.appearance.material : d.appearance.material
  s.appearance.surfaceOpacity = clamp(s.appearance.surfaceOpacity, 0, 100, d.appearance.surfaceOpacity)
  s.appearance.uiFontSize = clamp(s.appearance.uiFontSize, 11, 20, d.appearance.uiFontSize)
  s.appearance.radius = clamp(s.appearance.radius, 0, 1.5, d.appearance.radius)
  s.appearance.tabPosition = s.appearance.tabPosition === 'sidebar' ? 'sidebar' : 'top'
  s.terminal.fontSize = clamp(s.terminal.fontSize, 6, 40, d.terminal.fontSize)
  s.terminal.lineHeight = clamp(s.terminal.lineHeight, 1, 2.5, d.terminal.lineHeight)
  s.terminal.letterSpacing = clamp(s.terminal.letterSpacing, -5, 10, d.terminal.letterSpacing)
  s.terminal.fontWeight = clamp(Math.round(s.terminal.fontWeight / 100) * 100, 100, 900, d.terminal.fontWeight)
  s.terminal.fontWeightBold = clamp(Math.round(s.terminal.fontWeightBold / 100) * 100, 100, 900, d.terminal.fontWeightBold)
  s.terminal.scrollback = clamp(Math.round(s.terminal.scrollback), 500, 200000, d.terminal.scrollback)
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    s.terminal.padding[side] = clamp(s.terminal.padding[side], 0, 48, d.terminal.padding[side])
  }
  s.terminal.backgroundOpacity = clamp(s.terminal.backgroundOpacity, 0, 100, d.terminal.backgroundOpacity)
  s.terminal.minimumContrastRatio = clamp(s.terminal.minimumContrastRatio, 1, 21, d.terminal.minimumContrastRatio)
  s.terminal.cursorStyle = cursors.includes(s.terminal.cursorStyle) ? s.terminal.cursorStyle : d.terminal.cursorStyle
  s.terminal.renderer = s.terminal.renderer === 'dom' ? 'dom' : 'webgl'
  s.terminal.unicode = s.terminal.unicode === 'unicode11' ? 'unicode11' : 'graphemes'
  s.terminal.panelBackground = panelBackgrounds.includes(s.terminal.panelBackground)
    ? s.terminal.panelBackground
    : d.terminal.panelBackground
  s.terminal.diffColors = s.terminal.diffColors === 'original' ? 'original' : 'theme'
  if (!s.terminal.fontFamily.trim()) s.terminal.fontFamily = d.terminal.fontFamily
  s.claude.defaultCwdAsked = s.claude.defaultCwdAsked === true
  s.claude.usageRefreshMinutes = clamp(s.claude.usageRefreshMinutes, 2, 120, d.claude.usageRefreshMinutes)
  s.claude.defaultArgs = s.claude.defaultArgs.filter((a) => typeof a === 'string' && a.length > 0)
  s.claude.continuePrompt = typeof s.claude.continuePrompt === 'string' ? s.claude.continuePrompt.trim().slice(0, 2000) : d.claude.continuePrompt
  s.api.port = clamp(Math.round(s.api.port), 1024, 65535, d.api.port)
  s.general.closeOnExit = closeOnExit.includes(s.general.closeOnExit) ? s.general.closeOnExit : d.general.closeOnExit
  s.notifications.minBusySeconds = clamp(Math.round(s.notifications.minBusySeconds), 0, 3600, d.notifications.minBusySeconds)
  s.notifications.when = s.notifications.when === 'hidden' ? 'hidden' : 'background'
  return s
}
