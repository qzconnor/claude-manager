import { toast } from 'vue-sonner'
import { themeContent, uniqueThemeName } from '@shared/themes/file'
import type { AppTheme } from '@shared/themes/types'
import { errorMessage, toastError } from '@/lib/errors'
import { fileManagerLabel } from '@/lib/platform'
import { useSettingsStore } from '@/stores/settings'
import { useThemesStore } from '@/stores/themes'
import { useUiStore } from '@/stores/ui'

/** What the theme picker and the theme editor do with themes, with the messages that go with it. */
export function useThemeActions() {
  const themes = useThemesStore()
  const settings = useSettingsStore()
  const ui = useUiStore()

  const names = () => themes.all.map((t) => t.name)

  function edit(id: string): void {
    ui.themeEditorRequest = { mode: 'edit', id }
  }

  /** A new theme with the colors of `theme` (the built-in ones can only be changed like this). */
  function copy(theme: AppTheme): void {
    ui.themeEditorRequest = { mode: 'create', from: { ...themeContent(theme), name: uniqueThemeName(`${theme.name} (Kopie)`, names()) } }
  }

  /** A new theme that starts with the colors of the theme the app has now. */
  function createNew(): void {
    const current = themes.find(settings.settings.appearance.themeId)
    ui.themeEditorRequest = { mode: 'create', from: { ...themeContent(current), name: uniqueThemeName('Eigenes Theme', names()) } }
  }

  async function openFile(id: string): Promise<void> {
    try {
      if (!(await themes.openFile(id))) {
        toast.info('Kein Programm für JSON-Dateien', {
          description: `Die Datei ist im ${fileManagerLabel} markiert. Öffne sie dort mit einem Editor deiner Wahl.`,
        })
      }
    } catch (error) {
      toastError(error, 'Datei nicht geöffnet')
    }
  }

  async function showFile(id: string): Promise<void> {
    try {
      await themes.showFile(id)
    } catch (error) {
      toastError(error, 'Datei nicht gefunden')
    }
  }

  async function openFolder(): Promise<void> {
    try {
      await themes.openFolder()
    } catch (error) {
      toastError(error, 'Ordner nicht geöffnet')
    }
  }

  async function exportTheme(id: string): Promise<void> {
    try {
      const path = await themes.exportTheme(id)
      if (!path) return
      toast.success('Theme exportiert', {
        description: path,
        action: { label: `Im ${fileManagerLabel} zeigen`, onClick: () => void window.api.app.showItem(path) },
      })
    } catch (error) {
      toastError(error, 'Theme nicht exportiert')
    }
  }

  /** Asks for files without `files` (e.g. dropped ones); every theme in them becomes a new one. */
  async function importThemes(files?: string[]): Promise<void> {
    try {
      const result = await themes.importFiles(files)
      if (!result) return
      const { imported, failed } = result
      if (imported.length === 1) {
        const theme = imported[0].theme!
        toast.success(`Theme „${theme.name}“ importiert`, {
          action: { label: 'Verwenden', onClick: () => void settings.update({ appearance: { themeId: theme.id } }) },
        })
      } else if (imported.length > 1) {
        toast.success(`${imported.length} Themes importiert`)
      }
      for (const { file, error } of failed) {
        toast.error(`„${file.split(/[\\/]/).pop()}“ nicht importiert`, { description: error })
      }
    } catch (error) {
      toastError(error, 'Import fehlgeschlagen')
    }
  }

  /** Asks first; the file goes to the recycle bin. */
  async function remove(id: string): Promise<boolean> {
    const entry = themes.entry(id)
    const name = entry?.theme?.name ?? entry?.file.split(/[\\/]/).pop() ?? 'das Theme'
    const active = settings.settings.appearance.themeId === id || settings.settings.terminal.colorSchemeId === id
    const ok = await ui.confirm({
      title: `„${name}“ löschen?`,
      description: `Die Datei kommt in den Papierkorb, von dort lässt sie sich wiederherstellen.${
        active ? ' Wo das Theme gewählt ist, gilt wieder das Standard-Theme.' : ''
      }`,
      confirmText: 'Löschen',
      destructive: true,
    })
    if (!ok) return false
    try {
      await themes.remove(id)
      toast.success(`„${name}“ gelöscht`)
      return true
    } catch (error) {
      toast.error('Theme nicht gelöscht', { description: errorMessage(error) })
      return false
    }
  }

  return { edit, copy, createNew, openFile, showFile, openFolder, exportTheme, importThemes, remove }
}
