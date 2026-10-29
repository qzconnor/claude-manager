# Roadmap

Die App wurde in acht Schritten gebaut. Jeder Schritt baut auf dem vorherigen auf und wurde in der laufenden App geprüft.

## 1. Fundament ✓

- Electron 45 + electron-vite, Vue 3.5, TypeScript, Tailwind v4, shadcn-vue (Stil reka-nova), Pinia, vue-router.
- Getrennte Prozesse: Main (Services), Preload (typisierte `window.api`), Renderer (UI). IPC-Kanäle und Typen zentral in `src/shared`.
- Rahmenloses Fenster mit eigener Titelleiste und nativen Fensterknöpfen (Title Bar Overlay).
- Acryl, Mica und Mica Alt, auch bei inaktivem Fenster (`WM_NCACTIVATE`-Trick).
- 11 Themes, die zusammen mit der UI auch das Terminal einfärben. Einstellungen werden sofort angewendet und gespeichert.

## 2. Terminal ✓

- node-pty mit ConPTY, xterm.js 6 mit WebGL, Unicode 11 und Graphem-Clustern (ZWJ-Emoji), Web-Links und Suche.
- Ausgabe wird im Main-Prozess gepuffert, damit Tabs Seitenwechsel und Neuladen des Renderers ohne Verlust überstehen.
- Tabs mit Umbenennen, Kontextmenü, Mittelklick zum Schließen und Nachfrage bei laufendem Prozess.
- Anpassbar: Schrift (installierte Fonts mit Nerd-Font- und Emoji-Fallback), Größe, Zeilenhöhe, Abstand, Stärke, Cursor, Kontrast, Scrollback, Renderer. Mit Live-Vorschau.
- Tastatur: Umschalt+Enter für Zeilenumbruch, Strg+C/V mit Auswahl, App-Kürzel ohne Konflikt mit Claude Code.

## 3. Accounts ✓

- Standard-Login (`~/.claude`), eigene OAuth-Profile (`CLAUDE_CONFIG_DIR` + `claude auth login`), Long-lived Tokens (`CLAUDE_CODE_OAUTH_TOKEN`) und API-Keys (`ANTHROPIC_API_KEY`).
- Secrets DPAPI-verschlüsselt, Anmeldestatus und Plan werden angezeigt. Optional werden Einstellungen, Skills und Befehle aus `~/.claude` übernommen; verknüpfte Skills (z. B. aus `~/.agents`) bleiben Verknüpfungen, unter Windows als Junction ohne Admin-Rechte.

## 4. Sessions ✓

- Worker-Thread indexiert alle Transcripts, inklusive Titel, Prompts, Branch, Modell und Größe. Aktualisiert sich bei Dateiänderungen.
- Liste gruppiert nach Account, Suche, Detailansicht mit Markdown und Tool-Aufrufen.
- Fortsetzen (`--resume`) und Abzweigen (`--fork-session`) in einem neuen Tab.

## 5. Usage-Dashboard ✓

- Live-Limits über den OAuth-Usage-Endpunkt (wie cswap). Fallback auf den Cache von Claude Code, Drosselung und Backoff bei Rate-Limits.
- Token-Verbrauch pro Tag und Modell aus den lokalen Transcripts (inkl. Subagents), Zeitraum 7/14/30/90 Tage.
- Neue Logins bekommen ihre Limits sofort, nicht erst mit der nächsten Runde. Der Standard-Account fehlt im Dashboard und auf der Accounts-Seite, solange sein Login schon ein eigener Account ist.

## 6. Lokale API ✓

- REST + Server-Sent Events auf `127.0.0.1`, Bearer-Token, Host-Prüfung.
- OpenAPI 3.1 und HTML-Doku werden aus der Routen-Tabelle erzeugt. Siehe [API.md](API.md).

## 7. Packaging und Feinschliff ✓

- electron-builder: NSIS-Installer für Windows x64, native Module außerhalb des asar-Archivs, ohne Debug-Symbole (Paket ca. 8 MB plus Electron).
- App-Icon (`build/icon.svg` → `build/icon.png`).
- Fehler aus der Laufzeitprüfung behoben:
  - schwarze Kästen hinter gedimmtem Text im WebGL-Renderer
  - KeepAlive-Verwechslung beim Seitenwechsel
  - fehlende Ellipsen bei langen Titeln
  - Chart-Legende und Crosshair
  - Größe der Befehlspalette

## 8. Befehl `cm` und Feinschliff ✓

- `cm` öffnet eine Session im Manager, aus dem Terminal oder der Explorer-Adressleiste. Ordner, Account, `--continue`, `--resume`, Shell und durchgereichte Argumente. Der Installer richtet ihn ein (Benutzer-PATH + App-Pfad) und entfernt ihn wieder.
- Limits des aktiven Accounts in der Titelleiste, mit Details als Popover.
- Einheitliche, runde Umschalter (Segmented Control) und überall der Hand-Cursor für klickbare Elemente.
- Tabs werden nicht mehr abgeschnitten, und der Neu-Knopf hebt sich mit Rahmen ab.
- Tool-Aufrufe im Session-Verlauf lassen sich aufklappen (vollständige Eingabe und Ergebnis).
- Account wechseln, wenn ein Limit erreicht ist: Erkennung im Transcript, Hinweis im Tab, Wechsel per Klick. Tokens und API-Keys übernehmen die Session an Ort und Stelle, für Browser-Logins wird sie kopiert.
- Secrets über die asynchronen `safeStorage`-APIs (die synchronen sind seit Electron 45 veraltet). Bereits gespeicherte Tokens, API-Keys und der API-Token bleiben lesbar.
- Limit-Balken und -Ringe in Ampelfarben: grün unter 60 %, orange ab 60 %, rot ab 85 %.
- Nach einem Wechsel wegen eines Limits schickt die App eine einstellbare Nachricht („Mach weiter“), damit Claude ohne Eingabe weitermacht.
- Konten mit derselben E-Mail sind unterscheidbar („· Firma“ / „· Persönlich“). Die Identität kommt bei Browser-Logins von Anthropic statt aus der Konfiguration, die nach einem Wechsel mit cswap veraltet sein kann. Usage-Werte gehören zum Login, für den sie abgefragt wurden.
- Tabs schließen sich, wenn Claude Code oder die Shell ohne Fehler endet (z. B. Strg+C). Einstellbar: ohne Fehler, immer, nie. Beendet die App den Prozess selbst, etwa beim Account-Wechsel, bleibt der Tab.
- Import aus cswap, nur sichtbar, wenn cswap installiert ist und Accounts kennt. Übernommen werden Alias, E-Mail und Organisation aus `sequence.json`, nie cswaps Zugangsdaten. Jeder Account bekommt einen eigenen Browser-Login mit vorausgefüllter E-Mail. Ein Login mit anderer Person oder Organisation wird auf der Karte angezeigt.
- Die Nachfragen des Hauptprozesses (Beenden mit laufenden Terminals, Fehler von `cm`) erscheinen als Dialog in der App statt als Windows-Fenster. Nur wenn die Oberfläche abgestürzt ist, kommt die Windows-Box als Rückfall, damit sich das Fenster immer schließen lässt.
- Updates direkt in der App (electron-updater, GitHub-Releases) mit Versionshinweisen. Releases erstellt semantic-release bei jedem Push auf `master` aus den Conventional Commits.

## Mögliche nächste Schritte

- Code-Signing, sobald ein Zertifikat vorhanden ist (dann prüft electron-updater auch die Signatur des Updates).
- Geteilte Terminal-Ansicht (Split Panes) und Drag & Drop für Tabs.
- Benachrichtigung, wenn Claude Code in einem Hintergrund-Tab auf eine Eingabe wartet.
- Warnung, wenn ein Limit eine einstellbare Schwelle überschreitet.
