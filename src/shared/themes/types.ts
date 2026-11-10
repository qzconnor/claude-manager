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

/** A theme's colors without its id, e.g. as read from a file or being edited. */
export type ThemeContent = Omit<AppTheme, 'id'>

/** A file in the themes folder of the app's data. */
export interface CustomThemeEntry {
  /** `custom:` and the file's name without `.json`; what the settings keep. */
  id: string
  /** Absolute path of the file. */
  file: string
  /** The theme, null while the file can't be used. */
  theme: AppTheme | null
  /** Why the file can't be used (invalid JSON, a wrong color …). */
  error: string | null
}

/** Themes taken over from files: the new ones, and the files that could not be read. */
export interface ThemeImportResult {
  imported: CustomThemeEntry[]
  failed: { file: string; error: string }[]
}
