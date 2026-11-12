import type {
  CloseOnExit,
  CursorStyle,
  DiffColors,
  FileTreeSide,
  LogoColor,
  NotifyWhen,
  PanelBackground,
  ScreenReaderMode,
  TabPosition,
  TerminalRenderer,
  UnicodeMode,
  WindowMaterial,
} from '@shared/types'

/** The choices of the settings page with their names, for the page and for showing a setting's value (the import). */

export const FILE_TREE_SIDES: { value: FileTreeSide; label: string }[] = [
  { value: 'left', label: 'Links' },
  { value: 'right', label: 'Rechts' },
]

export const TAB_POSITIONS: { value: TabPosition; label: string }[] = [
  { value: 'top', label: 'Oben' },
  { value: 'sidebar', label: 'Seitenleiste' },
  { value: 'groups', label: 'Gruppen (wie VS Code)' },
]

export const MATERIALS: { value: WindowMaterial; label: string }[] = [
  { value: 'acrylic', label: 'Acryl' },
  { value: 'mica', label: 'Mica' },
  { value: 'tabbed', label: 'Mica Alt' },
  { value: 'none', label: 'Aus' },
]

export const CLOSE_ON_EXIT: { value: CloseOnExit; label: string }[] = [
  { value: 'graceful', label: 'Ohne Fehler' },
  { value: 'always', label: 'Immer' },
  { value: 'never', label: 'Nie' },
]

export const WHEN: { value: NotifyWhen; label: string }[] = [
  { value: 'background', label: 'Fenster im Hintergrund' },
  { value: 'hidden', label: 'Tab nicht sichtbar' },
]

export const CURSORS: { value: CursorStyle; label: string }[] = [
  { value: 'bar', label: 'Balken' },
  { value: 'block', label: 'Block' },
  { value: 'underline', label: 'Unterstrich' },
]

export const RENDERERS: { value: TerminalRenderer; label: string }[] = [
  { value: 'webgl', label: 'WebGL' },
  { value: 'dom', label: 'DOM' },
]

export const UNICODE_VERSIONS: { value: UnicodeMode; label: string }[] = [
  { value: 'graphemes', label: 'Unicode 15' },
  { value: 'unicode11', label: 'Unicode 11' },
]

export const SCREEN_READER: { value: ScreenReaderMode; label: string }[] = [
  { value: 'auto', label: 'Automatisch' },
  { value: 'on', label: 'An' },
  { value: 'off', label: 'Aus' },
]

export const PANEL_BACKGROUNDS: { value: PanelBackground; label: string }[] = [
  { value: 'theme', label: 'Theme' },
  { value: 'terminal', label: 'Terminal' },
  { value: 'original', label: 'Original' },
]

export const DIFF_COLORS: { value: DiffColors; label: string }[] = [
  { value: 'theme', label: 'Theme' },
  { value: 'original', label: 'Original' },
]

export const LOGO_COLORS: { value: LogoColor; label: string }[] = [
  { value: 'theme', label: 'Akzentfarbe' },
  { value: 'original', label: 'Original' },
]
