import { defineStore } from 'pinia'
import { ref } from 'vue'
import { createDefaultSettings } from '@shared/defaults'
import type { AppSettings, DeepPartial, SettingsImportResult } from '@shared/types'

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

  /** Asks for a file and takes over its settings; null when cancelled. */
  async function importFromFile(): Promise<SettingsImportResult | null> {
    const result = await window.api.settings.import()
    if (result) settings.value = result.settings
    return result
  }

  window.api.settings.onChanged((next) => {
    settings.value = next
  })

  return { settings, loaded, load, update, reset, exportToFile, importFromFile }
})
