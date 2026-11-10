import { contrastRatio, luminance, parseColor } from './colors'
import { themeColor, type ThemeColorKey } from './file'
import type { AppTheme, ThemeContent } from './types'

/**
 * What the theme editor and Claude's theme tools point out about a theme: text with too little
 * contrast, and a mode that doesn't fit its colors.
 */

/**
 * Text colors and the color they are read on: `min` as WCAG asks of normal text (4.5), and of text
 * that may be weaker (3: hints, labels on buttons). `label` names the color behind, as the editor does.
 */
export const CONTRAST_PAIRS: Partial<Record<ThemeColorKey, { against: ThemeColorKey; label: string; min: number }>> = {
  'app.foreground': { against: 'app.background', label: 'Hintergrund', min: 4.5 },
  'app.mutedForeground': { against: 'app.background', label: 'Hintergrund', min: 3 },
  'app.primaryForeground': { against: 'app.primary', label: 'Akzent', min: 3 },
  'terminal.foreground': { against: 'terminal.background', label: 'Hintergrund', min: 4.5 },
}

export interface ContrastIssue {
  key: ThemeColorKey
  against: ThemeColorKey
  label: string
  ratio: number
  min: number
}

/** The text color `key` with too little contrast to the color behind it; null when it has enough (or isn't text). */
export function contrastIssue(theme: ThemeContent, key: ThemeColorKey): ContrastIssue | null {
  const pair = CONTRAST_PAIRS[key]
  if (!pair) return null
  const text = parseColor(themeColor(theme, key))
  const back = parseColor(themeColor(theme, pair.against))
  if (!text || !back) return null
  const ratio = contrastRatio(text, back)
  return ratio < pair.min ? { key, ...pair, ratio } : null
}

/** Every text color of the theme with too little contrast. */
export function contrastIssues(theme: ThemeContent): ContrastIssue[] {
  return (Object.keys(CONTRAST_PAIRS) as ThemeColorKey[]).flatMap((key) => contrastIssue(theme, key) ?? [])
}

/** The mode the colors ask for when it isn't the theme's: text lighter than the background is a dark theme. */
export function suggestedMode(theme: ThemeContent): AppTheme['mode'] | null {
  const back = parseColor(theme.colors.background)
  const text = parseColor(theme.colors.foreground)
  if (!back || !text) return null
  const suggested = luminance(text) > luminance(back) ? 'dark' : 'light'
  return suggested === theme.mode ? null : suggested
}
