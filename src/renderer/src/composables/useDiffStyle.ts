import { computed } from 'vue'
import { buildFontStack, useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { codeColor } from '@/lib/code-colors'
import { useSettingsStore } from '@/stores/settings'

/**
 * How diffs look: in the colours of the terminal's theme, on its see-through background, in its font.
 * `colors` are the variables the code (`.syntax` in main.css) and the lines' tints read; `--diff-add-new`
 * is the lighter tint of a file that is all added, so it reads like code.
 */
export function useDiffStyle() {
  const settings = useSettingsStore()
  const { palette, containerBackground } = useTerminalAppearance()

  // The code's colours calmed for code: a terminal's blue can be too loud or too dark to read.
  const codeColors = computed(() => {
    const p = palette.value
    const code = (color: string) => codeColor(color, p.background)
    return { red: code(p.red), green: code(p.green), yellow: code(p.yellow), blue: code(p.blue), magenta: code(p.magenta), cyan: code(p.cyan) }
  })

  const colors = computed<Record<string, string>>(() => {
    const p = palette.value
    const c = codeColors.value
    const tint = (color: string, percent: number) => `color-mix(in oklab, ${color} ${percent}%, transparent)`
    return {
      background: containerBackground.value,
      color: p.foreground,
      '--syn-red': c.red,
      '--syn-green': c.green,
      '--syn-yellow': c.yellow,
      '--syn-blue': c.blue,
      '--syn-magenta': c.magenta,
      '--syn-cyan': c.cyan,
      '--syn-comment': tint(p.foreground, 50),
      '--diff-add': tint(c.green, 15),
      '--diff-add-new': tint(c.green, 6),
      '--diff-add-gutter': tint(c.green, 24),
      '--diff-del': tint(c.red, 15),
      '--diff-del-gutter': tint(c.red, 24),
      // The words that changed in a line, over its tint.
      '--diff-add-word': tint(c.green, 32),
      '--diff-del-word': tint(c.red, 32),
      '--diff-hunk': tint(p.foreground, 6),
      // The hatching of a side without a line, side by side.
      '--diff-filler': tint(p.foreground, 12),
      '--diff-header': tint(p.foreground, 5),
      '--diff-number': tint(p.foreground, 40),
      '--diff-add-number': c.green,
      '--diff-del-number': c.red,
    }
  })

  const fontSize = computed(() => Math.max(10, Math.round(settings.settings.appearance.uiFontSize * 0.93)))
  const rowHeight = computed(() => Math.round(fontSize.value * 1.55))
  const fontFamily = computed(() => buildFontStack(settings.settings.terminal.fontFamily))

  return { colors, fontSize, rowHeight, fontFamily }
}
