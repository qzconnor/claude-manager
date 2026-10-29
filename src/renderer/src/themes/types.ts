export interface TerminalPalette {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface ThemeColors {
  /** Window base color (tinted over the acrylic). */
  background: string
  foreground: string
  /** Muted text. */
  mutedForeground: string
  /** Base color of cards / panels. */
  surface: string
  /** Opaque color of menus, popovers and dialogs. */
  popover: string
  primary: string
  primaryForeground: string
  destructive: string
  success: string
  warning: string
}

export interface AppTheme {
  id: string
  name: string
  mode: 'dark' | 'light'
  colors: ThemeColors
  terminal: TerminalPalette
}
