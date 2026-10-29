import type { AppearanceSettings } from '@shared/types'
import type { AppTheme } from './types'

const mix = (color: string, percent: number, other = 'transparent') =>
  `color-mix(in oklab, ${color} ${percent}%, ${other})`

/**
 * Writes all design tokens of a theme to <html>. Translucent layers are expressed with
 * color-mix so the window material (acrylic/mica) shines through cards, sidebar and body.
 */
export function applyTheme(theme: AppTheme, appearance: AppearanceSettings, translucent: boolean): void {
  const c = theme.colors
  const t = theme.terminal
  const root = document.documentElement
  const opacity = translucent ? appearance.surfaceOpacity : 100
  const isDark = theme.mode === 'dark'

  const tokens: Record<string, string> = {
    '--background': c.background,
    '--foreground': c.foreground,
    '--card': mix(c.surface, translucent ? Math.min(100, opacity + 8) : 100),
    '--card-foreground': c.foreground,
    '--popover': c.popover,
    '--popover-foreground': c.foreground,
    '--primary': c.primary,
    '--primary-foreground': c.primaryForeground,
    '--secondary': mix(c.foreground, isDark ? 9 : 7),
    '--secondary-foreground': c.foreground,
    '--muted': mix(c.foreground, isDark ? 7 : 5),
    '--muted-foreground': c.mutedForeground,
    '--accent': mix(c.foreground, isDark ? 10 : 7),
    '--accent-foreground': c.foreground,
    '--destructive': c.destructive,
    '--border': mix(c.foreground, isDark ? 11 : 13),
    '--input': mix(c.foreground, isDark ? 15 : 18),
    '--ring': mix(c.primary, 65),
    '--chart-1': c.primary,
    '--chart-2': t.blue,
    '--chart-3': t.green,
    '--chart-4': t.yellow,
    '--chart-5': t.magenta,
    '--radius': `${appearance.radius}rem`,
    '--sidebar': mix(c.background, translucent ? Math.max(0, opacity - 30) : 100),
    '--sidebar-foreground': c.foreground,
    '--sidebar-primary': c.primary,
    '--sidebar-primary-foreground': c.primaryForeground,
    '--sidebar-accent': mix(c.foreground, isDark ? 10 : 8),
    '--sidebar-accent-foreground': c.foreground,
    '--sidebar-border': mix(c.foreground, isDark ? 9 : 11),
    '--sidebar-ring': mix(c.primary, 65),
    '--surface': mix(c.surface, translucent ? Math.min(100, opacity) : 100),
    '--surface-strong': mix(c.surface, translucent ? Math.min(100, opacity + 18) : 100),
    '--success': c.success,
    '--warning': c.warning,
    '--window-bg': mix(c.background, opacity),
    '--ui-font-size': `${appearance.uiFontSize}px`,
  }
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value)
  root.classList.toggle('dark', isDark)
  root.style.colorScheme = theme.mode
  root.dataset.theme = theme.id
}
