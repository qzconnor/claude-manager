import type { SettingsTab } from '@/router'
import { containsTerms, searchText } from './search'

/**
 * Every card and row of the settings page, for the search on the page and the command palette.
 * `id` is the anchor the page puts on the card or row (`anchor` of SettingsSection and SettingField,
 * `data-setting` elsewhere); a test checks that the page and this list agree. `keywords` are other
 * words people may look for, e.g. from the description.
 */

/** A label that differs between Windows and the other systems. */
type PlatformText = string | { readonly windows: string; readonly other: string }

interface FieldDef {
  readonly id: string
  readonly label: PlatformText
  readonly keywords?: string
  /** Only shown on Windows, e.g. what needs the window material. */
  readonly windowsOnly?: boolean
}

interface SectionDef {
  readonly id: string
  readonly title: string
  readonly keywords?: string
  readonly fields?: readonly FieldDef[]
}

interface TabDef {
  readonly tab: SettingsTab
  readonly label: string
  /** The tab has no controls to show in the search, so its hits there lead to the tab. */
  readonly linked?: boolean
  readonly sections: readonly SectionDef[]
}

const TREE = [
  {
    tab: 'appearance',
    label: 'Darstellung',
    sections: [
      {
        id: 'appearance.theme',
        title: 'Theme',
        keywords: 'Farben Farbschema hell dunkel Design',
        fields: [
          {
            id: 'appearance.customThemes',
            label: 'Eigene Themes',
            keywords: 'Theme erstellen bearbeiten Editor Farbwähler Color Picker anpassen kopieren importieren exportieren teilen JSON Datei löschen',
          },
        ],
      },
      {
        id: 'appearance.tabs',
        title: 'Tabs',
        keywords: 'Tableiste Reiter',
        fields: [{ id: 'appearance.tabPosition', label: 'Position', keywords: 'oben Titelleiste Seitenleiste Sidebar vertikal Navigation Gruppen VS Code Editor Layout Modus' }],
      },
      {
        id: 'appearance.fileTree',
        title: 'Dateibaum',
        keywords: 'Dateien Explorer Ordner Tree Baum Projekt',
        fields: [{ id: 'appearance.fileTreeSide', label: 'Seite', keywords: 'links rechts Position Seitenleiste Panel Strg+Umschalt+E' }],
      },
      {
        id: 'appearance.window',
        title: 'Fenster',
        keywords: 'Oberfläche',
        fields: [
          { id: 'appearance.material', label: 'Material', keywords: 'Acryl Mica Transparenz durchsichtig Hintergrund', windowsOnly: true },
          { id: 'appearance.keepMaterial', label: 'Auch ohne Fokus beibehalten', keywords: 'Material inaktiv Hintergrund', windowsOnly: true },
          { id: 'appearance.surfaceOpacity', label: 'Deckkraft', keywords: 'Transparenz durchsichtig undurchsichtig Material', windowsOnly: true },
          { id: 'appearance.uiFontSize', label: 'Schriftgröße der Oberfläche', keywords: 'Text Größe Zoom' },
          { id: 'appearance.radius', label: 'Eckenradius', keywords: 'Ecken abgerundet Rundung' },
        ],
      },
    ],
  },
  {
    tab: 'terminal',
    label: 'Terminal',
    sections: [
      { id: 'terminal.preview', title: 'Vorschau', keywords: 'Beispiel' },
      {
        id: 'terminal.font',
        title: 'Schrift',
        keywords: 'Font',
        fields: [
          { id: 'terminal.fontFamily', label: 'Schriftart', keywords: 'Familie Monospace Nerd Emoji' },
          { id: 'terminal.fontSize', label: 'Schriftgröße', keywords: 'Größe Zoom vergrößern verkleinern' },
          { id: 'terminal.lineHeight', label: 'Zeilenhöhe', keywords: 'Zeilenabstand' },
          { id: 'terminal.letterSpacing', label: 'Zeichenabstand', keywords: 'Buchstabenabstand Laufweite' },
          { id: 'terminal.ligatures', label: 'Ligaturen', keywords: 'Pfeil => != JetBrains Mono Fira Code Cascadia Code' },
          { id: 'terminal.fontWeight', label: 'Schriftstärke', keywords: 'fett bold normal Gewicht' },
        ],
      },
      {
        id: 'terminal.look',
        title: 'Aussehen',
        fields: [
          { id: 'terminal.colorScheme', label: 'Farbschema', keywords: 'Theme Farben' },
          { id: 'terminal.backgroundOpacity', label: 'Hintergrund-Deckkraft', keywords: 'Transparenz durchsichtig Acryl Material', windowsOnly: true },
          { id: 'terminal.panelBackground', label: 'Hintergrund von Claude-Flächen', keywords: 'Seitenleisten diff Balken Eingaben grau' },
          { id: 'terminal.diffColors', label: 'Diff-Farben', keywords: 'grün rot Änderungen' },
          { id: 'terminal.logoColor', label: 'Claude-Logo', keywords: 'Krabbe Clawd Maskottchen Animation Akzentfarbe orange' },
          { id: 'terminal.cursorStyle', label: 'Cursor', keywords: 'Balken Block Unterstrich Form' },
          { id: 'terminal.cursorBlink', label: 'Cursor blinkt', keywords: 'blinken' },
          { id: 'terminal.contrast', label: 'Mindestkontrast', keywords: 'Kontrast lesbar aufhellen' },
        ],
      },
      {
        id: 'terminal.padding',
        title: 'Innenabstand',
        keywords: 'Padding Rand Abstand',
        fields: [
          { id: 'terminal.paddingTop', label: 'Oben' },
          { id: 'terminal.paddingBottom', label: 'Unten', keywords: 'Prompt' },
          { id: 'terminal.paddingLeft', label: 'Links' },
          { id: 'terminal.paddingRight', label: 'Rechts', keywords: 'Scrollbar' },
        ],
      },
      {
        id: 'terminal.behavior',
        title: 'Verhalten',
        fields: [
          { id: 'terminal.copyOnSelect', label: 'Beim Markieren kopieren', keywords: 'Auswahl Zwischenablage' },
          { id: 'terminal.rightClickPaste', label: 'Rechtsklick kopiert / fügt ein', keywords: 'einfügen Maus Zwischenablage' },
          { id: 'terminal.scrollback', label: 'Scrollback', keywords: 'Zeilen Verlauf Puffer' },
        ],
      },
      {
        id: 'terminal.rendering',
        title: 'Rendering',
        fields: [
          { id: 'terminal.renderer', label: 'Renderer', keywords: 'WebGL DOM GPU Grafiktreiber' },
          { id: 'terminal.unicode', label: 'Unicode', keywords: 'Emoji Graphem Zeichen' },
          { id: 'terminal.modernConpty', label: 'ConPTY aus Windows Terminal', keywords: 'Konsole Hintergrundfarbe Theme Auto', windowsOnly: true },
        ],
      },
    ],
  },
  {
    tab: 'claude',
    label: 'Claude Code',
    sections: [
      {
        id: 'claude.program',
        title: 'Claude Code',
        keywords: 'Programm Startoptionen',
        fields: [
          { id: 'claude.installation', label: 'Gefundene Installation', keywords: 'Version prüfen' },
          {
            id: 'claude.executablePath',
            label: { windows: 'Pfad zur claude.exe', other: 'Pfad zu claude' },
            keywords: 'Programm ausführbar PATH',
          },
          { id: 'claude.defaultArgs', label: 'Standard-Argumente', keywords: 'Parameter Optionen Modell model' },
          { id: 'claude.defaultCwd', label: 'Standard-Arbeitsordner', keywords: 'Ordner Verzeichnis Downloads Projekt' },
          { id: 'claude.autoSwitch', label: 'Bei einem Limit automatisch wechseln', keywords: 'Account Rate Limit' },
          { id: 'claude.continuePrompt', label: 'Nachricht nach Account-Wechsel', keywords: 'Prompt weitermachen fortsetzen Limit' },
        ],
      },
      {
        id: 'claude.command',
        title: 'Befehl „cm“',
        keywords: 'cm Kommandozeile CLI Explorer Adressleiste',
        fields: [
          { id: 'claude.commandRegistered', label: 'Befehl einrichten', keywords: 'PATH installieren' },
          { id: 'claude.commandReuseTab', label: 'Offenen Tab wiederverwenden', keywords: 'Ordner wechseln' },
        ],
      },
      {
        id: 'claude.general',
        title: 'Allgemein',
        fields: [
          { id: 'claude.defaultAccount', label: 'Standard-Account', keywords: 'Konto neue Session' },
          { id: 'claude.restoreTerminals', label: 'Tabs beim Start wiederherstellen', keywords: 'Sessions fortsetzen Neustart' },
          { id: 'claude.confirmClose', label: 'Schließen laufender Terminals bestätigen', keywords: 'Nachfrage' },
          { id: 'claude.closeOnExit', label: 'Tab schließen, wenn der Prozess endet', keywords: 'beenden exit' },
          { id: 'claude.usageRefresh', label: 'Usage-Aktualisierung', keywords: 'Limits Nutzung Intervall Minuten' },
        ],
      },
      {
        id: 'claude.startup',
        title: 'Start und Infobereich',
        keywords: 'Tray Autostart',
        fields: [
          { id: 'claude.runInTray', label: 'Im Infobereich weiterlaufen', keywords: 'Tray Hintergrund schließen' },
          {
            id: 'claude.launchAtLogin',
            label: { windows: 'Mit Windows starten', other: 'Beim Anmelden starten' },
            keywords: 'Autostart Systemstart Anmelden',
          },
        ],
      },
    ],
  },
  {
    tab: 'tools',
    label: 'Werkzeuge',
    sections: [
      {
        id: 'claude.browser',
        title: 'Browser',
        keywords: 'Webseite MCP',
        fields: [
          { id: 'claude.browserTools', label: 'Browser für Claude-Sessions', keywords: 'MCP Server Werkzeuge Tools' },
          { id: 'claude.browserToolsAllowed', label: 'Ohne Nachfrage bedienen', keywords: 'Erlaubnis Berechtigung fragen' },
          { id: 'claude.noClaudeInChrome', label: 'Ohne Claude in Chrome', keywords: 'Erweiterung no-chrome' },
          { id: 'claude.clearBrowserData', label: 'Browserdaten löschen', keywords: 'Cookies Cache abmelden Logins' },
        ],
      },
      {
        id: 'tools.app',
        title: 'Claude Manager',
        keywords: 'MCP Werkzeuge Tools App',
        fields: [
          { id: 'claude.appContext', label: 'Claude kennt die App', keywords: 'Systemprompt Prompt Kontext Tokens sparen' },
          { id: 'claude.hookState', label: 'Zustand über Hooks melden', keywords: 'Hooks Benachrichtigungen Status Werkzeug Subagents Infokarte' },
          { id: 'claude.diffCommand', label: '/diff zeigt alle Änderungen', keywords: 'diff Befehl Slash-Command Review Git Änderungen Skill' },
          { id: 'claude.limitsTool', label: 'Eigene Limits lesen', keywords: 'Usage Nutzung Rate Limit Account' },
          { id: 'claude.sessionsTool', label: 'Sessions durchsuchen', keywords: 'Verlauf Transcript Chatverlauf frühere' },
          { id: 'claude.themesTool', label: 'Themes erstellen', keywords: 'Farben Farbschema Theme-Editor Design Aussehen' },
          { id: 'claude.shellTools', label: 'Shell-Tabs steuern', keywords: 'Terminal Befehle Dev-Server Ausgabe PowerShell' },
          { id: 'claude.shellToolsAllowed', label: 'Ohne Nachfrage', keywords: 'Erlaubnis Berechtigung fragen Shell' },
        ],
      },
    ],
  },
  {
    tab: 'notifications',
    label: 'Benachrichtigungen',
    sections: [
      {
        id: 'notifications.main',
        title: 'Benachrichtigungen',
        keywords: 'Mitteilungen',
        fields: [
          { id: 'notifications.enabled', label: 'Benachrichtigungen', keywords: 'einschalten ausschalten stumm' },
          { id: 'notifications.test', label: 'Ausprobieren', keywords: 'Test Beispiel' },
        ],
      },
      {
        id: 'notifications.events',
        title: 'Ereignisse',
        fields: [
          { id: 'notifications.onDone', label: 'Claude ist fertig', keywords: 'Antwort beendet' },
          { id: 'notifications.minBusy', label: 'Erst nach längerer Arbeit (Sekunden)', keywords: 'Dauer' },
          { id: 'notifications.onInput', label: 'Claude braucht dich', keywords: 'Erlaubnis Frage Plan wartet' },
          { id: 'notifications.onLimit', label: 'Limit erreicht', keywords: 'Nutzungslimit Reset' },
          { id: 'notifications.onNearLimit', label: 'Limit fast verbraucht', keywords: 'Warnung Usage' },
          { id: 'notifications.nearLimitPercent', label: 'Schwelle (%)', keywords: 'Prozent Limit' },
        ],
      },
      {
        id: 'notifications.hints',
        title: 'Hinweise',
        fields: [
          { id: 'notifications.when', label: 'Benachrichtigen, wenn', keywords: 'Hintergrund sichtbar' },
          {
            id: 'notifications.toast',
            label: { windows: 'Windows-Benachrichtigung', other: 'Systembenachrichtigung' },
            keywords: 'Toast Mitteilungszentrale',
          },
          { id: 'notifications.preview', label: 'Vorschau', keywords: 'Inhalt Antwort' },
          { id: 'notifications.sound', label: 'Ton', keywords: 'Sound Klang' },
          {
            id: 'notifications.flash',
            label: { windows: 'Taskleiste blinkt', other: 'Fenster in der Taskleiste markieren' },
            keywords: 'blinken Taskleiste',
          },
          { id: 'notifications.unreadDot', label: 'Punkt am Tab', keywords: 'ungelesen Markierung' },
        ],
      },
    ],
  },
  {
    tab: 'api',
    label: 'API',
    sections: [
      {
        id: 'api.server',
        title: 'Lokale API',
        keywords: 'HTTP Schnittstelle REST Server',
        fields: [
          { id: 'api.enabled', label: 'API aktivieren', keywords: 'einschalten' },
          { id: 'api.port', label: 'Port' },
          { id: 'api.url', label: 'Adresse', keywords: 'URL localhost' },
          { id: 'api.token', label: 'Token', keywords: 'Bearer Authorization Schlüssel' },
        ],
      },
      {
        id: 'api.docs',
        title: 'Dokumentation',
        keywords: 'OpenAPI Referenz Endpunkte',
        fields: [{ id: 'api.openDocs', label: 'API-Dokumentation', keywords: 'Docs Browser' }],
      },
    ],
  },
  {
    tab: 'updates',
    label: 'Updates',
    linked: true,
    sections: [
      { id: 'updates.status', title: 'Updates', keywords: 'Aktualisierung neue Version suchen installieren herunterladen' },
      { id: 'updates.notes', title: 'Versionshinweise', keywords: 'Changelog Neuerungen Release Notes' },
    ],
  },
  {
    tab: 'about',
    label: 'Info',
    linked: true,
    sections: [
      {
        id: 'about.info',
        title: 'Über Claude Manager',
        keywords: 'Version Electron Chromium Node Claude-Pfad System Windows-Build',
        fields: [{ id: 'about.dataDir', label: 'Datenordner öffnen', keywords: 'Daten Speicherort' }],
      },
    ],
  },
] as const satisfies readonly TabDef[]

type Section = (typeof TREE)[number]['sections'][number]
type Field = Extract<Section, { fields: unknown }>['fields'][number]
/** Anchor of a card or row of the settings page. */
export type SettingsAnchor = Section['id'] | Field['id']

export const SETTINGS_TAB_LABELS = Object.fromEntries(TREE.map((t) => [t.tab, t.label])) as Record<SettingsTab, string>

export interface SettingsEntry {
  id: SettingsAnchor
  kind: 'section' | 'field'
  tab: SettingsTab
  label: string
  /** The card a row is in. */
  section?: SettingsAnchor
  /** Where it is, for lists: the tab, and the card of a row, without repeating the label. */
  path: string[]
  /** The tab has no controls to show in the search (see `linked`). */
  linked: boolean
  /** Text the search terms are tested against (see `searchText`). */
  text: string
}

/** The cards and rows the settings page shows on this platform (`process.platform`), in their order. */
export function settingsIndex(platform: string): SettingsEntry[] {
  const windows = platform === 'win32'
  const text = (value: PlatformText) => (typeof value === 'string' ? value : windows ? value.windows : value.other)
  const path = (label: string, ...parts: string[]) => [...new Set(parts)].filter((part) => part !== label)
  const entries: SettingsEntry[] = []
  for (const tab of TREE as readonly TabDef[]) {
    const linked = !!tab.linked
    for (const section of tab.sections) {
      entries.push({
        id: section.id as SettingsAnchor,
        kind: 'section',
        tab: tab.tab,
        label: section.title,
        path: path(section.title, tab.label),
        linked,
        text: searchText(section.title, section.keywords, tab.label),
      })
      for (const field of section.fields ?? []) {
        if (field.windowsOnly && !windows) continue
        const label = text(field.label)
        entries.push({
          id: field.id as SettingsAnchor,
          kind: 'field',
          tab: tab.tab,
          label,
          section: section.id as SettingsAnchor,
          path: path(label, tab.label, section.title),
          linked,
          text: searchText(label, field.keywords, section.title, tab.label),
        })
      }
    }
  }
  return entries
}

export interface SettingsMatch {
  /**
   * Cards and rows to show: the hits, every row of a card that is a hit (its title was looked for),
   * and the card of every row that is one.
   */
  ids: ReadonlySet<SettingsAnchor>
  /** Tabs with something to show, in their order. */
  tabs: SettingsTab[]
}

/** What of the settings page matches the search terms (see `searchTerms`); null without terms. */
export function matchSettings(entries: readonly SettingsEntry[], terms: string[]): SettingsMatch | null {
  if (terms.length === 0) return null
  const hits = new Set(entries.filter((entry) => containsTerms(entry.text, terms)).map((entry) => entry.id))
  const ids = new Set<SettingsAnchor>()
  for (const entry of entries) {
    if (!hits.has(entry.id) && !(entry.section && hits.has(entry.section))) continue
    if (entry.section) ids.add(entry.section)
    ids.add(entry.id)
  }
  const tabs = [...new Set(entries.filter((entry) => ids.has(entry.id)).map((entry) => entry.tab))]
  return { ids, tabs }
}
