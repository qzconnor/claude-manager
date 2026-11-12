import { defineStore } from 'pinia'
import { ref } from 'vue'
import { createDefaultSettings } from '@shared/defaults'
import type { AppSettings, DeepPartial, SettingsImportPreview } from '@shared/types'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>(createDefaultSettings(window.api.platform))
  const loaded = ref(false)

  async function load(): Promise<void> {
    settings.value = await window.api.settings.get()
    loaded.value = true
  }

  async function update(patch: DeepPartial<AppSettings>): Promise<void> {
    settings.value = await window.api.settings.update(patch)
  }

  async function reset(section?: keyof AppSettings): Promise<void> {
    settings.value = await window.api.settings.reset(section)
  }

  /** Asks for a file and saves the settings there, without accounts. The path, or null when cancelled. */
  function exportToFile(): Promise<string | null> {
    return window.api.settings.export()
  }

  /** Asks for a file and reads what its settings would change; null when cancelled. Nothing is taken over yet. */
  function previewImport(): Promise<SettingsImportPreview | null> {
    return window.api.settings.previewImport()
  }

  window.api.settings.onChanged((next) => {
    settings.value = next
  })

  return { settings, loaded, load, update, reset, exportToFile, previewImport }
})
