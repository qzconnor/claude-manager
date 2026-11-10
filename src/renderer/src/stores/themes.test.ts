import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive, ref } from 'vue'
import { createDefaultSettings } from '@shared/defaults'
import { findTheme } from '@shared/themes/builtin'
import { themeContent } from '@shared/themes/file'
import type { AppSettings } from '@shared/types'
import type { CustomThemeEntry, ThemeContent } from '@shared/themes/types'

/** Like Electron's IPC: arguments are structured-cloned, which fails on Vue's reactive proxies. */
function entryFor(id: string, theme: ThemeContent): CustomThemeEntry {
  const sent = structuredClone(theme)
  return { id, file: `/themes/${id.slice('custom:'.length)}.json`, theme: { id, ...sent }, error: null }
}

let settings: AppSettings
const api = {
  platform: 'win32',
  settings: {
    get: vi.fn(async () => settings),
    update: vi.fn(async (patch: Partial<AppSettings>) => {
      settings = {
        ...settings,
        appearance: { ...settings.appearance, ...patch.appearance },
        terminal: { ...settings.terminal, ...patch.terminal },
      }
      return settings
    }),
    onChanged: () => () => {},
  },
  themes: {
    list: vi.fn(async (): Promise<CustomThemeEntry[]> => []),
    create: vi.fn(async (theme: ThemeContent) => entryFor('custom:neu', theme)),
    save: vi.fn(async (id: string, theme: ThemeContent) => entryFor(theme.name === 'Umbenannt' ? 'custom:umbenannt' : id, theme)),
    remove: vi.fn(async () => {}),
    onChanged: () => () => {},
    onSaved: () => () => {},
  },
}

async function store() {
  const { useThemesStore } = await import('./themes')
  return useThemesStore()
}

/** The editor's draft: a ref, so the theme and its color groups are reactive proxies. */
function draft(name: string) {
  return ref<ThemeContent>({ ...themeContent(findTheme('ember')), name }).value
}

beforeEach(() => {
  settings = createDefaultSettings('win32')
  vi.stubGlobal('window', { api })
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useThemesStore', () => {
  it('sends a plain copy of a reactive draft over IPC', async () => {
    const themes = await store()
    const theme = draft('Neu')
    expect(() => structuredClone({ ...theme })).toThrow()

    const created = await themes.create({ ...theme, name: 'Neu' })
    expect(created.theme?.colors.primary).toBe(theme.colors.primary)
    const saved = await themes.save(created.id, reactive({ ...theme, name: 'Neu' }))
    expect(saved.theme?.terminal.brightRed).toBe(theme.terminal.brightRed)
    expect(themes.custom.map((t) => t.id)).toEqual(['custom:neu'])
  })

  it('lets the settings follow a renamed theme and fall back when it is deleted', async () => {
    const themes = await store()
    const { useSettingsStore } = await import('./settings')
    const app = useSettingsStore()
    await themes.create(draft('Neu'))
    await app.update({ appearance: { themeId: 'custom:neu' }, terminal: { colorSchemeId: 'custom:neu' } })

    await themes.save('custom:neu', draft('Umbenannt'))
    expect(app.settings.appearance.themeId).toBe('custom:umbenannt')
    expect(app.settings.terminal.colorSchemeId).toBe('custom:umbenannt')
    expect(themes.custom.map((t) => t.id)).toEqual(['custom:umbenannt'])

    await themes.remove('custom:umbenannt')
    expect(app.settings.appearance.themeId).toBe(createDefaultSettings('win32').appearance.themeId)
    expect(app.settings.terminal.colorSchemeId).toBeNull()
    expect(themes.custom).toEqual([])
  })
})
