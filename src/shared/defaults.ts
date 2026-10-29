import type { AppSettings } from './types'

export const SYSTEM_ACCOUNT_ID = 'system'

/**
 * Fonts appended to the user's terminal font so emoji and symbols always render.
 * The Nerd Font entries provide prompt icons (Starship, oh-my-posh) when one of them is installed.
 */
export const TERMINAL_FONT_FALLBACKS = [
  'Cascadia Mono',
  'Consolas',
  'Symbols Nerd Font Mono',
  'JetBrainsMono Nerd Font Mono',
  'CaskaydiaMono Nerd Font Mono',
  'CaskaydiaCove Nerd Font Mono',
  'Segoe UI Emoji',
  'Segoe UI Symbol',
  'Noto Color Emoji',
  'monospace',
]

/** Monospace fonts suggested first in the font picker (only shown when installed). */
export const RECOMMENDED_TERMINAL_FONTS = [
  'Cascadia Mono',
  'Cascadia Code',
  'CaskaydiaCove Nerd Font',
  'CaskaydiaMono Nerd Font',
  'JetBrains Mono',
  'JetBrainsMono Nerd Font',
  'JetBrainsMono Nerd Font Mono',
  'Fira Code',
  'FiraCode Nerd Font',
  'Geist Mono',
  'Iosevka',
  'Hack',
  'Source Code Pro',
  'Consolas',
]

export const ACCOUNT_COLORS = [
  '#d97757',
  '#7aa2f7',
  '#9ece6a',
  '#bb9af7',
  '#e0af68',
  '#7dcfff',
  '#f7768e',
  '#2dd4bf',
]

export function createDefaultSettings(): AppSettings {
  return {
    appearance: {
      themeId: 'ember',
      material: 'acrylic',
      keepMaterialWhenInactive: true,
      surfaceOpacity: 72,
      uiFontSize: 14,
      radius: 0.625,
    },
    terminal: {
      fontFamily: 'Cascadia Mono',
      fontSize: 14,
      lineHeight: 1.2,
      letterSpacing: 0,
      fontWeight: 400,
      fontWeightBold: 700,
      cursorStyle: 'bar',
      cursorBlink: true,
      scrollback: 10000,
      padding: 12,
      backgroundOpacity: 0,
      renderer: 'webgl',
      unicode: 'graphemes',
      copyOnSelect: false,
      rightClickPaste: true,
      colorSchemeId: null,
      minimumContrastRatio: 1,
    },
    claude: {
      executablePath: '',
      defaultCwd: '',
      defaultArgs: [],
      usageRefreshMinutes: 5,
      continuePrompt: 'Mach weiter',
    },
    general: {
      confirmCloseRunning: true,
      closeOnExit: 'graceful',
      defaultAccountId: SYSTEM_ACCOUNT_ID,
    },
    api: {
      enabled: false,
      port: 47821,
    },
  }
}
