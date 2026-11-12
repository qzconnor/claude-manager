import type { SettingChange } from '@shared/types'
import type { SettingsTab } from '@/router'
import { formatArgs } from './args'
import {
  CLOSE_ON_EXIT,
  CURSORS,
  DIFF_COLORS,
  FILE_TREE_SIDES,
  LOGO_COLORS,
  MATERIALS,
  PANEL_BACKGROUNDS,
  RENDERERS,
  SCREEN_READER,
  TAB_POSITIONS,
  UNICODE_VERSIONS,
  WHEN,
} from './setting-choices'
import { SETTINGS_TAB_LABELS, settingsIndex, type SettingsAnchor, type SettingsEntry } from './settings-index'

/** Settings of this installation: an export leaves them out, an import never changes them. */
export const LOCAL_SETTINGS = ['general.defaultAccountId', 'claude.defaultCwdAsked']

/**
 * Where each setting is on the settings page: its row, or the card when it has no row of its own.
 * `label` where the row's label alone would be unclear in a list of changes ("Ohne Nachfrage").
 */
export const SETTING_PLACES: Record<string, { anchor: SettingsAnchor; label?: string }> = {
  'appearance.themeId': { anchor: 'appearance.theme', label: 'Theme' },
  'appearance.material': { anchor: 'appearance.material', label: 'Fenster-Material' },
  'appearance.keepMaterialWhenInactive': { anchor: 'appearance.keepMaterial', label: 'Material auch ohne Fokus' },
  'appearance.surfaceOpacity': { anchor: 'appearance.surfaceOpacity', label: 'Deckkraft der Flächen' },
  'appearance.uiFontSize': { anchor: 'appearance.uiFontSize' },
  'appearance.radius': { anchor: 'appearance.radius' },
  'appearance.tabPosition': { anchor: 'appearance.tabPosition', label: 'Position der Tabs' },
  'appearance.fileTreeSide': { anchor: 'appearance.fileTreeSide', label: 'Seite des Dateibaums' },
  'terminal.fontFamily': { anchor: 'terminal.fontFamily' },
  'terminal.fontSize': { anchor: 'terminal.fontSize' },
  'terminal.lineHeight': { anchor: 'terminal.lineHeight' },
  'terminal.letterSpacing': { anchor: 'terminal.letterSpacing' },
  'terminal.ligatures': { anchor: 'terminal.ligatures' },
  'terminal.fontWeight': { anchor: 'terminal.fontWeight', label: 'Schriftstärke normal' },
  'terminal.fontWeightBold': { anchor: 'terminal.fontWeight', label: 'Schriftstärke fett' },
  'terminal.cursorStyle': { anchor: 'terminal.cursorStyle' },
  'terminal.cursorBlink': { anchor: 'terminal.cursorBlink' },
  'terminal.scrollback': { anchor: 'terminal.scrollback' },
  'terminal.padding.top': { anchor: 'terminal.paddingTop', label: 'Innenabstand oben' },
  'terminal.padding.right': { anchor: 'terminal.paddingRight', label: 'Innenabstand rechts' },
  'terminal.padding.bottom': { anchor: 'terminal.paddingBottom', label: 'Innenabstand unten' },
  'terminal.padding.left': { anchor: 'terminal.paddingLeft', label: 'Innenabstand links' },
  'terminal.backgroundOpacity': { anchor: 'terminal.backgroundOpacity' },
  'terminal.renderer': { anchor: 'terminal.renderer' },
  'terminal.unicode': { anchor: 'terminal.unicode' },
  'terminal.screenReader': { anchor: 'terminal.screenReader' },
  'terminal.copyOnSelect': { anchor: 'terminal.copyOnSelect' },
  'terminal.rightClickPaste': { anchor: 'terminal.rightClickPaste' },
  'terminal.multiLinePasteWarning': { anchor: 'terminal.multiLinePasteWarning' },
  'terminal.colorSchemeId': { anchor: 'terminal.colorScheme', label: 'Farbschema des Terminals' },
  'terminal.minimumContrastRatio': { anchor: 'terminal.contrast' },
  'terminal.panelBackground': { anchor: 'terminal.panelBackground' },
  'terminal.diffColors': { anchor: 'terminal.diffColors' },
  'terminal.logoColor': { anchor: 'terminal.logoColor' },
  'terminal.modernConpty': { anchor: 'terminal.modernConpty' },
  'claude.executablePath': { anchor: 'claude.executablePath' },
  'claude.defaultCwd': { anchor: 'claude.defaultCwd' },
  'claude.defaultArgs': { anchor: 'claude.defaultArgs' },
  'claude.usageRefreshMinutes': { anchor: 'claude.usageRefresh' },
  'claude.continuePrompt': { anchor: 'claude.continuePrompt' },
  'claude.autoSwitch': { anchor: 'claude.autoSwitch' },
  'claude.hideSecretsFromCommands': { anchor: 'claude.hideSecrets' },
  'claude.browserTools': { anchor: 'claude.browserTools' },
  'claude.browserToolsAllowed': { anchor: 'claude.browserToolsAllowed', label: 'Browser ohne Nachfrage bedienen' },
  'claude.browserSensitiveAllowed': { anchor: 'claude.browserSensitiveAllowed', label: 'Heikle Browser-Werkzeuge ohne Nachfrage' },
  'claude.noClaudeInChrome': { anchor: 'claude.noClaudeInChrome' },
  'claude.claudeInChromeHintDismissed': { anchor: 'claude.noClaudeInChrome', label: 'Hinweis zu Claude in Chrome ausgeblendet' },
  'claude.appContext': { anchor: 'claude.appContext' },
  'claude.hookState': { anchor: 'claude.hookState' },
  'claude.diffCommand': { anchor: 'claude.diffCommand' },
  'claude.limitsTool': { anchor: 'claude.limitsTool' },
  'claude.sessionsTool': { anchor: 'claude.sessionsTool' },
  'claude.themesTool': { anchor: 'claude.themesTool' },
  'claude.shellTools': { anchor: 'claude.shellTools' },
  'claude.shellToolsAllowed': { anchor: 'claude.shellToolsAllowed', label: 'Shell-Tabs ohne Nachfrage' },
  'general.confirmCloseRunning': { anchor: 'claude.confirmClose' },
  'general.closeOnExit': { anchor: 'claude.closeOnExit' },
  'general.restoreTerminals': { anchor: 'claude.restoreTerminals' },
  'general.restoreAsleep': { anchor: 'claude.restoreAsleep' },
  'general.cmReuseTab': { anchor: 'claude.commandReuseTab', label: '„cm“ nutzt einen offenen Tab' },
  'general.runInTray': { anchor: 'claude.runInTray' },
  'general.launchAtLogin': { anchor: 'claude.launchAtLogin' },
  'notifications.enabled': { anchor: 'notifications.enabled' },
  'notifications.onDone': { anchor: 'notifications.onDone' },
  'notifications.minBusySeconds': { anchor: 'notifications.minBusy' },
  'notifications.onInput': { anchor: 'notifications.onInput' },
  'notifications.onLimit': { anchor: 'notifications.onLimit' },
  'notifications.onNearLimit': { anchor: 'notifications.onNearLimit' },
  'notifications.nearLimitPercent': { anchor: 'notifications.nearLimitPercent', label: 'Schwelle für „Limit fast verbraucht“' },
  'notifications.onLoginLost': { anchor: 'notifications.onLoginLost' },
  'notifications.when': { anchor: 'notifications.when' },
  'notifications.toast': { anchor: 'notifications.toast' },
  'notifications.preview': { anchor: 'notifications.preview', label: 'Vorschau in der Benachrichtigung' },
  'notifications.sound': { anchor: 'notifications.sound' },
  'notifications.flashTaskbar': { anchor: 'notifications.flash' },
  'notifications.unreadDot': { anchor: 'notifications.unreadDot' },
  'api.enabled': { anchor: 'api.enabled' },
  'api.port': { anchor: 'api.port', label: 'Port der API' },
}

/** A change with the name the settings page gives it. */
export interface ShownChange extends SettingChange {
  label: string
}

/** The changes on one tab of the settings page. */
export interface ChangeGroup {
  tab: SettingsTab | null
  label: string
  changes: ShownChange[]
}

/**
 * The changes grouped by the tab of the settings page they are on, both in the page's order.
 * `platform`: `process.platform`, for labels that differ between the systems.
 */
export function groupChanges(changes: readonly SettingChange[], platform: string): ChangeGroup[] {
  // Rows only Windows shows keep their place and name elsewhere too.
  const order = [...settingsIndex('win32'), ...settingsIndex(platform)]
  const entries = new Map<SettingsAnchor, SettingsEntry>(order.map((entry) => [entry.id, entry]))
  const rank = (anchor: SettingsAnchor | undefined) => (anchor ? order.findIndex((entry) => entry.id === anchor) : order.length)
  const groups = new Map<SettingsTab | null, ChangeGroup>()
  const sorted = [...changes].sort((a, b) => rank(SETTING_PLACES[a.path]?.anchor) - rank(SETTING_PLACES[b.path]?.anchor))
  for (const change of sorted) {
    const place = SETTING_PLACES[change.path]
    const entry = place ? entries.get(place.anchor) : undefined
    const tab = entry?.tab ?? null
    let group = groups.get(tab)
    if (!group) {
      group = { tab, label: tab ? SETTINGS_TAB_LABELS[tab] : 'Weitere', changes: [] }
      groups.set(tab, group)
    }
    group.changes.push({ ...change, label: place?.label ?? entry?.label ?? change.path })
  }
  // In the page's order, the tabs too: the index lists them one after the other.
  return [...groups.values()]
}

const CHOICES: Record<string, readonly { value: string; label: string }[]> = {
  'appearance.material': MATERIALS,
  'appearance.tabPosition': TAB_POSITIONS,
  'appearance.fileTreeSide': FILE_TREE_SIDES,
  'terminal.cursorStyle': CURSORS,
  'terminal.renderer': RENDERERS,
  'terminal.unicode': UNICODE_VERSIONS,
  'terminal.screenReader': SCREEN_READER,
  'terminal.panelBackground': PANEL_BACKGROUNDS,
  'terminal.diffColors': DIFF_COLORS,
  'terminal.logoColor': LOGO_COLORS,
  'general.closeOnExit': CLOSE_ON_EXIT,
  'notifications.when': WHEN,
}

const UNITS: Record<string, string> = {
  'appearance.surfaceOpacity': '%',
  'appearance.uiFontSize': 'px',
  'terminal.fontSize': 'px',
  'terminal.letterSpacing': 'px',
  'terminal.padding.top': 'px',
  'terminal.padding.right': 'px',
  'terminal.padding.bottom': 'px',
  'terminal.padding.left': 'px',
  'terminal.backgroundOpacity': '%',
  'terminal.scrollback': 'Zeilen',
  'claude.usageRefreshMinutes': 'Min.',
  'notifications.minBusySeconds': 's',
  'notifications.nearLimitPercent': '%',
}

/** What the settings page shows for an empty value, e.g. as placeholder. */
const EMPTY: Record<string, string> = {
  'claude.executablePath': 'Automatisch',
  'claude.defaultCwd': 'Standard',
  'claude.defaultArgs': 'keine',
  'claude.continuePrompt': 'nichts schicken',
}

/** Settings that hold the id of a theme. */
export const THEME_SETTINGS = ['appearance.themeId', 'terminal.colorSchemeId']

/**
 * A setting's value the way the settings page names it. `themeName`: the name of the theme with an
 * id, null when there is no such theme here.
 */
export function settingValueText(path: string, value: unknown, themeName: (id: string) => string | null): string {
  if (THEME_SETTINGS.includes(path)) {
    if (value === null) return 'Wie App-Theme'
    if (typeof value === 'string') return themeName(value) ?? `„${value}“ (fehlt hier)`
  }
  const choice = CHOICES[path]?.find((option) => option.value === value)
  if (choice) return choice.label
  if (value === '' || (Array.isArray(value) && value.length === 0)) return EMPTY[path] ?? '(leer)'
  if (value === true) return 'An'
  if (value === false) return 'Aus'
  if (path === 'appearance.radius' && typeof value === 'number') return `${Math.round(value * 16)} px`
  if (path === 'api.port') return String(value)
  if (typeof value === 'number') {
    const number = value.toLocaleString('de-DE', { maximumFractionDigits: 2 })
    return UNITS[path] ? `${number} ${UNITS[path]}` : number
  }
  if (Array.isArray(value)) return formatArgs(value.map(String))
  if (value === null) return '–'
  return String(value)
}
