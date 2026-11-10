import { ANSI_COLORS, type AnsiColor, type ThemeColorKey } from '@shared/themes/file'

/** What a color of a theme is for, as the editor explains it. */
export interface ColorInfo {
  key: ThemeColorKey
  label: string
  description: string
}

export interface ColorGroup {
  id: string
  title: string
  colors: ColorInfo[]
}

export interface ColorSection {
  id: 'app' | 'terminal'
  title: string
  description: string
  groups: ColorGroup[]
}

const ANSI_LABELS: Record<AnsiColor, string> = {
  black: 'Schwarz',
  red: 'Rot',
  green: 'Grün',
  yellow: 'Gelb',
  blue: 'Blau',
  magenta: 'Magenta',
  cyan: 'Cyan',
  white: 'Weiß',
}

/** Where programs and the app use each ANSI color, besides the output of programs. */
const ANSI_USES: Record<AnsiColor, string> = {
  black: 'Selten als Text, eher für Hintergründe von Leisten.',
  red: 'Fehler; getönt hinter entfernten Zeilen in Diffs, auch in der Code-Ansicht.',
  green: 'Erfolg; getönt hinter hinzugefügten Zeilen in Diffs. Strings in der Code-Ansicht, Diagramme im Usage-Dashboard.',
  yellow: 'Warnungen. Zahlen und Klassen in der Code-Ansicht, Diagramme im Usage-Dashboard.',
  blue: 'Links, Pfade und Infos. Funktionen in der Code-Ansicht, Diagramme im Usage-Dashboard.',
  magenta: 'Schlüsselwörter in der Code-Ansicht, Diagramme im Usage-Dashboard.',
  cyan: 'Typen und eingebaute Namen in der Code-Ansicht.',
  white: 'Heller Text in dunklen Themes, gedämpfter in hellen.',
}

const BRIGHT_USES: Partial<Record<AnsiColor, string>> = {
  black: 'Grau: gedämpfter Text, Hinweise und Platzhalter von Claude Code und Shells.',
  white: 'Hellster Text, z. B. fett gedruckte Überschriften.',
}

function ansi(bright: boolean): ColorInfo[] {
  return ANSI_COLORS.map((color, i) => ({
    key: `terminal.${bright ? 'bright' : 'normal'}.${color}` as const,
    label: bright ? `Helles ${ANSI_LABELS[color]}` : ANSI_LABELS[color],
    description: `ANSI ${bright ? i + 8 : i}. ${bright ? (BRIGHT_USES[color] ?? `Hervorgehobene Ausgabe in ${ANSI_LABELS[color]}.`) : ANSI_USES[color]}`,
  }))
}

/** Every color of a theme, grouped as in the file. */
export const COLOR_SECTIONS: ColorSection[] = [
  {
    id: 'app',
    title: 'App',
    description: 'Fenster, Seiten, Menüs und Dialoge.',
    groups: [
      {
        id: 'app.base',
        title: 'Fenster und Text',
        colors: [
          {
            key: 'app.background',
            label: 'Hintergrund',
            description: 'Grundfarbe des Fensters und der Seitenleiste. Unter Windows liegt sie je nach Deckkraft über Acryl oder Mica.',
          },
          {
            key: 'app.foreground',
            label: 'Text',
            description: 'Schrift und Symbole. Rahmen, Trennlinien und Hover-Flächen werden daraus gemischt.',
          },
          {
            key: 'app.mutedForeground',
            label: 'Gedämpfter Text',
            description: 'Beschreibungen, Platzhalter, Zeitangaben und inaktive Tabs.',
          },
        ],
      },
      {
        id: 'app.surfaces',
        title: 'Flächen',
        colors: [
          {
            key: 'app.surface',
            label: 'Karten und Panels',
            description: 'Karten, Abschnitte der Einstellungen, Tab-Leisten und Dateibaum. Durchscheinend, solange das Fenstermaterial an ist.',
          },
          {
            key: 'app.popover',
            label: 'Menüs und Dialoge',
            description: 'Deckende Fläche von Menüs, Tooltips, Dialogen und der Befehlspalette.',
          },
        ],
      },
      {
        id: 'app.accent',
        title: 'Akzent',
        colors: [
          {
            key: 'app.primary',
            label: 'Akzent',
            description: 'Hauptknöpfe, Auswahl, Fokusrahmen, eingeschaltete Schalter und Schieberegler.',
          },
          {
            key: 'app.primaryForeground',
            label: 'Text auf Akzent',
            description: 'Schrift und Symbole auf akzentfarbenen Knöpfen und Markierungen.',
          },
        ],
      },
      {
        id: 'app.status',
        title: 'Status',
        colors: [
          {
            key: 'app.destructive',
            label: 'Fehler',
            description: 'Löschen-Knöpfe, Fehlermeldungen, ungültige Eingaben und Limits ab 85 %.',
          },
          {
            key: 'app.success',
            label: 'Erfolg',
            description: 'Bestätigungen, Aktivitätspunkte und Limits unter 60 %.',
          },
          {
            key: 'app.warning',
            label: 'Warnung',
            description: 'Hinweise, Sessions, die auf dich warten, und Treffer der Suche. Mit Rot gemischt: Limits ab 60 %.',
          },
        ],
      },
    ],
  },
  {
    id: 'terminal',
    title: 'Terminal',
    description: 'Terminals, Code- und Diff-Ansicht des Dateibaums.',
    groups: [
      {
        id: 'terminal.base',
        title: 'Grundfarben',
        colors: [
          {
            key: 'terminal.background',
            label: 'Hintergrund',
            description: 'Hinter Terminals und der Code-Ansicht. Claude Codes Theme „Auto“ wählt danach hell oder dunkel.',
          },
          {
            key: 'terminal.foreground',
            label: 'Text',
            description: 'Normale Ausgabe. Seitenleisten wie /diff und die Leiste hinter deinen Nachrichten werden damit leicht getönt.',
          },
          { key: 'terminal.cursor', label: 'Cursor', description: 'Die Schreibmarke.' },
          {
            key: 'terminal.cursorAccent',
            label: 'Text unter dem Cursor',
            description: 'Das Zeichen unter einem Block-Cursor.',
          },
          {
            key: 'terminal.selectionBackground',
            label: 'Auswahl',
            description: 'Hinter markiertem Text. Darf durchsichtig sein, damit der Text lesbar bleibt.',
          },
        ],
      },
      { id: 'terminal.normal', title: 'Normale Farben (ANSI 0–7)', colors: ansi(false) },
      { id: 'terminal.bright', title: 'Helle Farben (ANSI 8–15)', colors: ansi(true) },
    ],
  },
]
