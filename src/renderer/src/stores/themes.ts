import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { DEFAULT_THEME_ID, findTheme, THEMES } from '@shared/themes/builtin'
import { themeContent } from '@shared/themes/file'
import type { AppSettings, DeepPartial } from '@shared/types'
import type { AppTheme, CustomThemeEntry, ThemeContent, ThemeImportResult } from '@shared/themes/types'
import { useSettingsStore } from './settings'

/**
 * The user's own themes, one file each in the themes folder of the app's data. The folder is
 * watched: files copied in, edited in another program or deleted there show at once. A theme
 * chosen in the settings whose file is gone leaves the setting as it is (an editor that saves by
 * replacing the file, the recycle bin): the default theme shows until the file is back.
 */
export const useThemesStore = defineStore('themes', () => {
  const settings = useSettingsStore()
  const entries = ref<CustomThemeEntry[]>([])
  const loaded = ref(false)
  /** Only the latest read counts: an older one still under way would undo a theme just saved. */
  let generation = 0

  const custom = computed<AppTheme[]>(() => entries.value.flatMap((e) => (e.theme ? [e.theme] : [])))
  /** The built-in themes, then the user's own. */
  const all = computed<AppTheme[]>(() => [...THEMES, ...custom.value])

  /** The theme `id`; the default theme if there is none (also while its file is gone). */
  function find(id: string | null | undefined): AppTheme {
    return findTheme(id, custom.value)
  }

  function exists(id: string | null | undefined): boolean {
    return !!id && all.value.some((t) => t.id === id)
  }

  function entry(id: string | null | undefined): CustomThemeEntry | undefined {
    return entries.value.find((e) => e.id === id)
  }

  async function load(): Promise<void> {
    const mine = ++generation
    const next = await window.api.themes.list()
    if (mine !== generation) return
    entries.value = next
    loaded.value = true
  }

  /** Shows a theme the app just wrote at once; the folder's watcher brings the list again shortly. */
  function put(next: CustomThemeEntry, replacing?: string): void {
    generation++
    const rest = entries.value.filter((e) => e.id !== next.id && e.id !== replacing)
    entries.value = [...rest, next].sort((a, b) =>
      (a.theme?.name ?? a.id).localeCompare(b.theme?.name ?? b.id, 'de', { sensitivity: 'base' }),
    )
  }

  async function create(theme: ThemeContent): Promise<CustomThemeEntry> {
    // A plain copy: reactive objects (the editor's draft) can't go over IPC.
    const created = await window.api.themes.create(themeContent(theme))
    put(created)
    return created
  }

  /** A new name gives the theme a new file and id: settings that chose it follow. */
  async function save(id: string, theme: ThemeContent): Promise<CustomThemeEntry> {
    const saved = await window.api.themes.save(id, themeContent(theme))
    put(saved, id)
    if (saved.id !== id) await follow(id, saved.id)
    return saved
  }

  /** To the recycle bin; settings that chose it go back to the default theme. */
  async function remove(id: string): Promise<void> {
    await window.api.themes.remove(id)
    generation++
    entries.value = entries.value.filter((e) => e.id !== id)
    await follow(id, null)
  }

  /** Settings that chose the theme `from` take `to` instead; with null the default. */
  async function follow(from: string, to: string | null): Promise<void> {
    const { appearance, terminal } = settings.settings
    const patch: DeepPartial<AppSettings> = {}
    if (appearance.themeId === from) patch.appearance = { themeId: to ?? DEFAULT_THEME_ID }
    if (terminal.colorSchemeId === from) patch.terminal = { colorSchemeId: to }
    if (patch.appearance || patch.terminal) await settings.update(patch)
  }

  async function importFiles(files?: string[]): Promise<ThemeImportResult | null> {
    const result = await window.api.themes.import(files)
    for (const imported of result?.imported ?? []) put(imported)
    return result
  }

  window.api.themes.onChanged(() => {
    void load().catch((error) => console.error('[themes] list could not be read', error))
  })

  return {
    entries,
    loaded,
    custom,
    all,
    find,
    exists,
    entry,
    load,
    create,
    save,
    remove,
    importFiles,
    exportTheme: (id: string) => window.api.themes.export(id),
    openFile: (id: string) => window.api.themes.openFile(id),
    showFile: (id: string) => window.api.themes.showFile(id),
    openFolder: () => window.api.themes.openFolder(),
  }
})
