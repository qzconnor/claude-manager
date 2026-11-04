/**
 * The `cm` command on Linux: a shell script in ~/.local/bin that the app writes itself. It does
 * what cm.exe does on Windows (src/launcher/cm.cs): it hands the working directory and its
 * arguments to the app as one Base64 switch (src/main/cli/launch.ts reads it) and returns at once.
 * The app's path is part of the script, because an AppImage is only mounted while it runs.
 */

/** Identifies a script written by the app, so a `cm` of another program is never touched. */
export const LAUNCHER_MARK = '# claude-manager-launcher'

const HELP = `
Claude Manager – Claude-Code-Session aus der Kommandozeile öffnen

  cm                    Session im aktuellen Ordner
  cm <ordner>           Session in <ordner>
  cm -a <account>       mit Account (Name, E-Mail oder ID)
  cm -c                 letzte Session in diesem Ordner fortsetzen
  cm -r [session-id]    Session fortsetzen (ohne ID: Auswahl in Claude Code)
  cm -s                 Shell mit Account-Umgebung statt Claude Code
  cm -n                 neuer Tab, auch wenn der Ordner schon offen ist
  cm -- <argumente>     Argumente an claude weitergeben, z. B. cm -- --model opus
`

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function launcherScript(app: string): string {
  return `#!/bin/sh
${LAUNCHER_MARK}
# Der Befehl „cm“ von Claude Manager. Die App hat ihn angelegt und hält den Pfad aktuell,
# abmelden lässt er sich unter Einstellungen → Claude Code → Befehl „cm“.
APP=${quote(app)}

if [ "$#" -eq 1 ] && { [ "$1" = -h ] || [ "$1" = --help ]; }; then
  cat <<'HELP'
${HELP.trim()}
HELP
  exit 0
fi

if [ ! -x "$APP" ]; then
  echo "cm: Claude Manager wurde nicht gefunden: $APP" >&2
  exit 1
fi

# Ordner und Argumente, getrennt durch NUL-Zeichen, als ein Base64-Wert: Chromium ordnet Schalter
# um und schreibt sie neu, ein einzelner undurchsichtiger Wert kommt unverändert an.
PAYLOAD=$({ printf '%s' "$PWD"; for arg in "$@"; do printf '\\000%s' "$arg"; done; } | base64 | tr -d '\\n')

# Aus einem Prozess unter einer Electron-App (z. B. einer VS-Code-Erweiterung) geerbt, würde die
# App sonst als reines Node.js starten.
unset ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE

# In einer eigenen Sitzung: Das Schließen des Terminals beendet die App nicht.
if command -v setsid >/dev/null 2>&1; then
  setsid "$APP" "--cm=$PAYLOAD" </dev/null >/dev/null 2>&1 &
else
  nohup "$APP" "--cm=$PAYLOAD" </dev/null >/dev/null 2>&1 &
fi
`
}

/** The app path in a script written by `launcherScript`, `null` for any other file. */
export function launcherTarget(script: string): string | null {
  if (!script.includes(LAUNCHER_MARK)) return null
  const match = /^APP='((?:[^']|'\\'')*)'$/m.exec(script)
  return match ? match[1].replaceAll(`'\\''`, "'") : null
}
