import { computed, watchEffect } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { applyTheme } from '@/themes/apply'
import { findTheme } from '@/themes/themes'

/** Applies the selected theme to the document and the native window chrome. */
export function useThemeSync() {
  const store = useSettingsStore()
  const theme = computed(() => findTheme(store.settings.appearance.themeId))

  watchEffect(() => {
    const appearance = store.settings.appearance
    applyTheme(theme.value, appearance, appearance.material !== 'none')
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
