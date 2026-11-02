import { join } from 'node:path'
import { createDefaultSettings } from '@shared/defaults'
import type { AppSettings, DeepPartial } from '@shared/types'
import { mergeKnown } from '@shared/utils'
import { readJsonSync, writeJsonAtomic } from '../lib/json-file'
import { TypedEmitter } from '../lib/typed-emitter'

type Events = { changed: [settings: AppSettings, previous: AppSettings] }

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
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Brings a settings file of an older version into the current shape. */
function migrate(stored: unknown): unknown {
  const terminal = (stored as { terminal?: { padding?: unknown } } | null)?.terminal
  // Earlier there was one padding for all sides; on the right at least the scrollbar's 14 px were kept free.
  if (terminal && typeof terminal.padding === 'number') {
    const p = terminal.padding
    terminal.padding = { top: p, right: Math.max(p, 14), bottom: p, left: p }
  }
  return stored ?? {}
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
  if (!s.terminal.fontFamily.trim()) s.terminal.fontFamily = d.terminal.fontFamily
  s.claude.usageRefreshMinutes = clamp(s.claude.usageRefreshMinutes, 2, 120, d.claude.usageRefreshMinutes)
  s.claude.defaultArgs = s.claude.defaultArgs.filter((a) => typeof a === 'string' && a.length > 0)
  s.claude.continuePrompt = typeof s.claude.continuePrompt === 'string' ? s.claude.continuePrompt.trim().slice(0, 2000) : d.claude.continuePrompt
  s.api.port = clamp(Math.round(s.api.port), 1024, 65535, d.api.port)
  s.general.closeOnExit = closeOnExit.includes(s.general.closeOnExit) ? s.general.closeOnExit : d.general.closeOnExit
  return s
}
