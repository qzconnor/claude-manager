import { defineStore } from 'pinia'
import { ref } from 'vue'
import { createDefaultSettings } from '@shared/defaults'
import type { AppSettings, DeepPartial } from '@shared/types'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>(createDefaultSettings())
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

  window.api.settings.onChanged((next) => {
    settings.value = next
  })

  return { settings, loaded, load, update, reset }
})
