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
- Filter nach Zeit (zuletzt aktiv / älter als) und Größe (größer / kleiner als), Mehrfachauswahl zum Aufräumen: Gelöschte Sessions kommen mit Subagents, `/rewind`-Ständen, Umgebung und Aufgabenliste in den Papierkorb. Offene und laufende Sessions bleiben.

## 5. Usage-Dashboard ✓

- Live-Limits über den OAuth-Usage-Endpunkt (wie cswap). Fallback auf den Cache von Claude Code, Drosselung und Backoff bei Rate-Limits.
- Token-Verbrauch pro Tag und Modell aus den lokalen Transcripts (inkl. Subagents), Zeitraum 7/14/30/90 Tage.
- Neue Logins bekommen ihre Limits sofort, nicht erst mit der nächsten Runde. Der Standard-Account fehlt im Dashboard und auf der Accounts-Seite, solange sein Login schon ein eigener Account ist.
- Accounts, die gerade nicht genutzt werden, bleiben live: Ihr abgelaufener Zugangstoken wird wie in Claude Code mit dem Refresh-Token erneuert (gleiche Sperre, Schreiben nur ohne zwischenzeitliche Änderung). Fenster, deren Reset vorbei ist, stehen auf 0 % statt auf dem alten Wert.

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
- Updates direkt in der App (electron-updater, GitHub-Releases) mit Versionshinweisen, als Tab in den Einstellungen. Releases erstellt semantic-release bei jedem Push auf `master` aus den Conventional Commits.
- Die Einstellungen haben eine Tab-Leiste über die ganze Breite mit Symbolen statt der kleinen Umschalter.
- Benachrichtigungen, wenn Claude in einem Tab fertig ist, auf eine Erlaubnis, Antwort oder Plan-Freigabe wartet oder an ein Limit stößt: Windows-Benachrichtigung mit Vorschau, Blinken der Taskleiste und ein Punkt an Tabs mit ungesehenen Neuigkeiten. Eigener Einstellungs-Tab, Glocke zum An- und Ausschalten, einzelne Tabs stummschaltbar. Der Grund kommt aus dem Transcript (`turn_duration`, offene Tool-Aufrufe), das Claude Code gepuffert schreibt.
- Warnung, wenn ein Limit eines Accounts eine einstellbare Schwelle erreicht (Standard 80 %): einmal pro Account, Zeitraum und Reset, gemerkt über Neustarts. Gilt für das 5-Stunden-Fenster, die Woche und die Wochenlimits einzelner Modelle.
- Claude Codes Theme „Auto“ folgt dem Theme der App, auch beim Wechsel in einer laufenden Session: Antwort auf OSC 11 mit dem Hintergrund des Themes, Meldung nach Modus 2031 und `COLORFGBG`. Neue Tabs nutzen dafür unter Windows die ConPTY aus Windows Terminal (abschaltbar), weil die von Windows die Farbabfrage schluckt.
- Tabs per Drag & Drop umsortieren (Titelleiste und Seitenleiste), Strg+1–8 springt zu einem Tab, Strg+9 zum letzten. Die Reihenfolge gilt auch für die lokale API und das Wiederherstellen beim nächsten Start.
- Unit-Tests mit Vitest für Parser, Regeln und Hilfsfunktionen von Main, Shared und Renderer; sie laufen in CI unter Windows und Linux.
- Einstellungen lassen sich als JSON-Datei exportieren und importieren, ohne Accounts. Fremde Pfade, die es hier nicht gibt, bleiben unverändert, der Import ist rückgängig zu machen.
- Zuletzt genutzte Ordner im Menü neben dem Plus, in der Befehlspalette und auf der leeren Terminal-Seite. Ein Klick startet dort eine Session mit dem Standard-Account, das Untermenü mit einem anderen Account oder als Shell. Die Ordner kommen aus offenen Tabs und gespeicherten Sessions; die Startordner, in denen eine neue Session ohnehin beginnt, fehlen.
- Automatischer Account-Wechsel am Limit (Einstellung, standardmäßig aus): Die Session läuft ohne Klick mit dem vorgeschlagenen Account weiter, der neue Tab nimmt den Platz des alten ein, die Benachrichtigung nennt den neuen Account. Verlassene Accounts bleiben bis zu ihrem Reset gesperrt. Die Auswahl der Accounts liegt jetzt in `src/shared/account-choice.ts` für Hauptprozess und Fenster; Accounts mit demselben Login gelten zusammen als am Limit.
- Geteilte Tabs: vertikal und horizontal teilen (Alt+Umschalt+Plus/Minus, Kontextmenü, Befehlspalette), beliebig verschachtelt, Trennlinien ziehen, Alt+Pfeil zwischen den Terminals. Die Aufteilung liegt im Hauptprozess (`src/shared/panes.ts`), übersteht ein Neuladen und wird mit den Tabs wiederhergestellt; ein neu gestartetes oder auf einen anderen Account gewechseltes Terminal behält seinen Platz.
- Browser als Tab oder Teil eines geteilten Tabs: `<webview>` mit Adressleiste, eigenem Profil und Sandbox, abgesichert im Hauptprozess (`will-attach-webview`, nur http/https, keine Popups und Berechtigungen). Die Kürzel der App kommen über `before-input-event` aus der Seite, die Kürzel-Erkennung liegt dafür in `src/shared/shortcuts.ts`. Titel und Adresse meldet das Fenster an den Hauptprozess, so stehen sie in der API und werden mit den Tabs wiederhergestellt. Das Symbol der Seite lädt der Hauptprozess über das Profil des Browsers und gibt es als Data-URL weiter (nur echte Bilder, am Inhalt erkannt), damit das Fenster weiter keine Bilder aus dem Netz laden darf.
- Browser für Claude: ein MCP-Server der App (Streamable HTTP, `src/main/browser/`), den nur Sessions aus der App per `--mcp-config` bekommen, mit eigenem Token pro Session. 17 Werkzeuge nach dem Vorbild von Playwright MCP, die Seite steuert der Hauptprozess über `webContents.debugger` (CDP) und Skripte in einer eigenen isolierten Welt; der Baum der Seite vergibt Refs, mit denen Claude Elemente anspricht. Hervorhebung des Elements in der Seite, ein Mauszeiger, der von Klick zu Klick gleitet (die Dauer bestimmt der Hauptprozess und wartet sie vor dem Klick ab, `src/main/browser/pointer.ts`), Statuspille über dem Fuß der Seite mit dem letzten Schritt (schrumpft, wenn Claude ruht), ein Klick des Nutzers in die Seite macht ihren Teil des Tabs aktiv (der Hauptprozess meldet Mausklicks über `before-mouse-event`, Claudes eigene ausgenommen), Protokoll mit Vorschaubildern, Konsolen- und Netzwerkfehlern, *Übernehmen*/*Zurückgeben*. Eigenheiten von Electron, um die es herum geht: Dialoge der Seite fängt ein Ersatz für `alert`/`confirm`/`prompt` ab, solange Claude handelt (Electrons eigenes Meldungsfenster schließt sich auf eine Antwort über CDP nicht); Tasten erreichen die Seite nur, solange das `<webview>` im Fenster den Fokus hat, das Fenster gibt ihn kurz ab und danach zurück; ganze Seiten werden aus Bildern je Fensterhöhe zusammengesetzt, weil die Seite im Fenster nur zeichnet, was sichtbar ist. Ein Browser, den Claude gerade bedient, wird in einem verborgenen Tab unsichtbar weiter gezeichnet.
- Browserdaten löschen (Einstellungen › Claude Code › Browser): `clearStorageData`, `clearCache` und `clearAuthCache` des Browser-Profils, offene Seiten laden neu. Cookies liegen verschlüsselt auf der Platte (Fuse `EnableCookieEncryption` über `electronFuses` in `electron-builder.yml`; nur in Richtung an, zurück würden die Cookies unlesbar).
- Seitengröße für Claude (`browser_resize`): eine feste Größe in CSS-Pixeln, wahlweise mobil (`Emulation.setDeviceMetricsOverride` mit `mobile`, Touch, User-Agent von Chrome auf Android; die Seite lädt dann neu), oder zurück zur Größe des Tabs. Das `<webview>` bekommt die Größe wirklich, das Fenster verkleinert es nur per CSS-`transform`, wenn es nicht passt: Screenshots, Refs und Klicks rechnen in Seitenpixeln, der Mauszeiger und die Hervorhebung rechnen mit dem Maßstab um. Rahmen mit Radius je Gerät, Badge mit Größe und X.
- Hinweis auf Claude in Chrome: Der Hauptprozess liest `claudeInChromeDefaultEnabled` aus der globalen Config jedes Accounts (nur claude.ai-Logins können verbinden) und `CLAUDE_CODE_ENABLE_CFC` (`src/main/browser/claude-in-chrome.ts`); Sessions dieser Accounts zeigen ein Banner wie beim Limit. *Ausschalten* setzt `noClaudeInChrome`, Sessions mit dem Browser der App starten dann mit `--no-chrome`, Claude Codes Config bleibt unberührt. *Jetzt neu starten* startet die Session am selben Platz neu und setzt sie fort (`SessionHandoff.restartTerminal`, derselbe Weg wie der Account-Wechsel, nur mit demselben Account und ohne Fortsetzen-Nachricht); Sessions, die schon mit `--no-chrome` laufen, zeigen kein Banner.

## Mögliche nächste Schritte

- Code-Signing, sobald ein Zertifikat vorhanden ist (dann prüft electron-updater auch die Signatur des Updates).
- Tabs per Drag & Drop in einen anderen Tab ziehen, um sie dort als Teil anzuzeigen.
