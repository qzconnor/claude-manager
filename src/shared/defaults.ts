import type { AppSettings } from './types'

export const SYSTEM_ACCOUNT_ID = 'system'

/** The newest messages of a session's history shown at first, and how many more each „Ältere laden“ brings. */
export const CONVERSATION_PAGE_MESSAGES = 600

/** The token statistics reach back at most this many days; the index keeps no older usage. */
export const MAX_STATS_DAYS = 365

/**
 * Fonts appended to the user's terminal font so emoji and symbols always render.
 * The Nerd Font entries provide prompt icons (Starship, oh-my-posh) when one of them is installed.
 */
export const TERMINAL_FONT_FALLBACKS = [
  'Cascadia Mono',
  'Consolas',
  // Linux: the monospace fonts of the common distributions.
  'DejaVu Sans Mono',
  'Noto Sans Mono',
  'Liberation Mono',
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

/**
 * `platform`: `process.platform` of the app. Windows has Cascadia Mono, elsewhere the terminal starts
 * with the font that ships with the app.
 */
export function createDefaultSettings(platform = 'win32'): AppSettings {
  return {
    appearance: {
      themeId: 'ember',
      material: 'acrylic',
      keepMaterialWhenInactive: true,
      surfaceOpacity: 72,
      uiFontSize: 14,
      radius: 0.625,
      tabPosition: 'top',
      fileTreeSide: 'left',
    },
    terminal: {
      fontFamily: platform === 'win32' ? 'Cascadia Mono' : 'Geist Mono Variable',
      fontSize: 14,
      lineHeight: 1.2,
      letterSpacing: 0,
      ligatures: true,
      fontWeight: 400,
      fontWeightBold: 700,
      cursorStyle: 'bar',
      cursorBlink: true,
      scrollback: 10000,
      // Right: the scrollbar (14 px) lies in the padding there and never covers text.
      padding: { top: 12, right: 14, bottom: 12, left: 12 },
      backgroundOpacity: 0,
      renderer: 'webgl',
      unicode: 'graphemes',
      screenReader: 'auto',
      copyOnSelect: false,
      rightClickPaste: true,
      multiLinePasteWarning: true,
      colorSchemeId: null,
      minimumContrastRatio: 1,
      panelBackground: 'theme',
      diffColors: 'theme',
      logoColor: 'theme',
      modernConpty: true,
    },
    claude: {
      executablePath: '',
      defaultCwd: '',
      defaultCwdAsked: false,
      defaultArgs: [],
      usageRefreshMinutes: 5,
      continuePrompt: 'Mach weiter',
      autoSwitch: false,
      hideSecretsFromCommands: false,
      browserTools: true,
      browserToolsAllowed: true,
      browserSensitiveAllowed: false,
      noClaudeInChrome: false,
      claudeInChromeHintDismissed: false,
      appContext: true,
      hookState: true,
      diffCommand: true,
      limitsTool: true,
      sessionsTool: true,
      themesTool: true,
      shellTools: false,
      shellToolsAllowed: false,
    },
    general: {
      confirmCloseRunning: true,
      closeOnExit: 'graceful',
      defaultAccountId: SYSTEM_ACCOUNT_ID,
      restoreTerminals: false,
      restoreAsleep: true,
      cmReuseTab: true,
      runInTray: false,
      launchAtLogin: false,
    },
    notifications: {
      enabled: true,
      onDone: true,
      minBusySeconds: 0,
      onInput: true,
      onLimit: true,
      onNearLimit: true,
      nearLimitPercent: 80,
      onLoginLost: true,
      when: 'background',
      toast: true,
      preview: true,
      sound: true,
      flashTaskbar: true,
      unreadDot: true,
    },
    api: {
      enabled: false,
      port: 47821,
    },
  }
}
