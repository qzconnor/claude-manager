import { computed, watchEffect } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { supportsMaterial } from '@/lib/platform'
import { useThemesStore } from '@/stores/themes'
import { applyTheme } from '@/themes/apply'

/** Applies the selected theme to the document and the native window chrome. */
export function useThemeSync() {
  const store = useSettingsStore()
  const themes = useThemesStore()
  const theme = computed(() => themes.find(store.settings.appearance.themeId))

  watchEffect(() => {
    const appearance = store.settings.appearance
    applyTheme(theme.value, appearance, supportsMaterial && appearance.material !== 'none')
  })

  watchEffect(() => {
    const t = theme.value
    void window.api.window.setTitleBarColors({
      color: '#00000000',
      symbolColor: t.colors.foreground,
      dark: t.mode === 'dark',
    })
  })

  return { theme }
}
