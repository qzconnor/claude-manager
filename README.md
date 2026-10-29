# Claude Manager

Desktop-App für Windows 11, die mehrere Claude-Code-Instanzen nebeneinander verwaltet: Terminals in Tabs, mehrere Accounts gleichzeitig, eine durchsuchbare Session-Liste (wie `/resume`, gruppiert nach Account), ein Usage-Dashboard und eine lokale API für andere Programme.

## Funktionen

- **Terminals**: xterm.js (WebGL) mit ConPTY. Farben, Emoji inkl. ZWJ-Sequenzen, Box-Drawing und Nerd-Font-Icons werden korrekt dargestellt. Tabs bleiben beim Seitenwechsel erhalten. Suche, Zoom, Kopieren/Einfügen, Umschalt+Enter für Zeilenumbrüche in Claude Code. Beendest du Claude mit Strg+C oder `/exit` (bzw. die Shell mit `exit`), schließt sich der Tab. Bei einem Fehler bleibt er offen, einstellbar unter Einstellungen › Claude Code.
- **Accounts**: beliebig viele Accounts parallel, auch mehrere Tabs mit demselben Account. Ist ein Account am Limit, läuft die Session mit einem anderen weiter (siehe unten). Accounts aus cswap lassen sich übernehmen.
- **Sessions**: alle gespeicherten Claude-Code-Sessions, gruppiert nach Account. Suche über Titel, ersten und letzten Prompt, Ordner, Git-Branch und Session-ID, Verlauf mit Markdown und Tool-Aufrufen, die sich aufklappen lassen: vollständige Eingabe und Ergebnis, Fehler rot markiert. Fortsetzen per Doppelklick oder als neue Session abzweigen (`--fork-session`).
- **Usage-Dashboard**: 5-Stunden- und Wochen-Limits (live, wie bei [cswap](https://github.com/realiti4/claude-swap)) sowie Token-Verbrauch pro Tag und Modell, berechnet aus den lokalen Transcripts. Ist der Login von `~/.claude` schon als eigener Account hinterlegt (etwa nach dem cswap-Import), lassen Dashboard und Accounts-Seite den Standard-Account weg, damit dieselben Limits nicht doppelt erscheinen. Auf der Accounts-Seite lässt er sich über den Hinweis unter den Karten wieder einblenden. Die Limits des Accounts im aktiven Tab stehen außerdem in der Titelleiste, ein Klick zeigt Details und Reset-Zeiten. Balken und Ringe sind grün (unter 60 %), orange (ab 60 %) und rot (ab 85 %), in den Farben des gewählten Themes.
- **Befehl `cm`**: öffnet eine Claude-Session im Manager, aus jedem Terminal oder direkt aus der Explorer-Adressleiste (siehe unten).
- **Darstellung**: Acryl, Mica oder Mica Alt, auch wenn das Fenster nicht im Fokus ist. 11 Themes (u. a. Catppuccin, Tokyo Night, Rosé Pine, Nord, Dracula). Das Terminal folgt dem Theme oder bekommt ein eigenes Farbschema. Schrift, Größe, Zeilenhöhe, Cursor usw. lassen sich mit Live-Vorschau einstellen.
- **Lokale API**: REST + Server-Sent Events auf `127.0.0.1`, Doku unter `/docs`, OpenAPI 3.1 unter `/openapi.json`. Siehe [docs/API.md](docs/API.md).
- **Befehlspalette** (Strg+Umschalt+P) für Aktionen, Navigation, offene Tabs und die letzten Sessions.

## Befehl `cm`

Der Installer richtet den Befehl `cm` ein. Wie `cmd` funktioniert er auch in der Adressleiste des Explorers: `cm` eintippen, Enter, und im Manager öffnet sich eine Session im angezeigten Ordner. Läuft die App noch nicht, startet sie.

| Aufruf | Wirkung |
|---|---|
| `cm` | Session im aktuellen Ordner mit dem Standard-Account |
| `cm <ordner>` | Session in `<ordner>` (relativ zum aktuellen Ordner, `~` = Benutzerordner) |
| `cm -a <account>` | mit Account: Name, E-Mail, ID oder ein eindeutiger Teil des Namens |
| `cm -c` | letzte Session in diesem Ordner fortsetzen (`claude --continue`) |
| `cm -r [session-id]` | Session fortsetzen, ohne ID mit der Auswahl von Claude Code |
| `cm -s` | PowerShell mit der Umgebung des Accounts statt Claude Code |
| `cm -- <argumente>` | Argumente an `claude` weitergeben, z. B. `cm -- --model opus` |
| `cm -h` | Hilfe |

Technisch ist `cm.exe` ein kleiner Launcher (`src/launcher/cm.cs`), der Ordner und Argumente an die laufende App weiterreicht. Er liegt im Unterordner `bin` der Installation, nur dieser Ordner kommt in den Benutzer-PATH. Für die Explorer-Adressleiste trägt der Installer zusätzlich einen App-Pfad unter `HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\cm.exe` ein. Admin-Rechte braucht beides nicht. Die Deinstallation entfernt beides wieder, der restliche PATH bleibt unverändert. In *Einstellungen → Claude Code* lässt sich der Befehl auch nachträglich an- und abmelden.

## Account wechseln, wenn ein Limit erreicht ist

Die App merkt, wenn Claude Code in einem Tab an ein Nutzungslimit stößt: Der Tab bekommt ein Warnsymbol, und oben im Terminal steht, welches Limit es ist und wann es zurückgesetzt wird. Ein Klick auf „Mit … fortsetzen“ beendet Claude Code im Tab und setzt dieselbe Session sofort mit dem anderen Account fort. Dasselbe geht jederzeit über das Tab-Kontextmenü (*Account wechseln*) und in *Sessions* über den Pfeil neben *Fortsetzen*.

- **Token- und API-Key-Accounts** leihen der Session nur ihren Schlüssel. Die Session bleibt, wo sie ist (gleiche ID, gleicher Verlauf, `/rewind` geht weiter), und läuft über die Limits des anderen Accounts. Der Tab zeigt den neuen Account, der Tooltip, wo die Session gespeichert ist.
- **Browser-Logins** (Standard, eigener Login) funktionieren nur im eigenen Ordner, weil Claude Code den Login dort erneuert. Die Session wird deshalb dorthin kopiert (Verlauf, Unterordner, `/rewind`-Stände) und läuft dort weiter. Beim bisherigen Account bleibt der Stand bis zum Wechsel. Liegt beim Ziel schon ein neuerer Stand derselben Session, bricht die App ab, ohne den Tab anzutasten.

Vorgeschlagen wird zuerst ein Account, der ohne Kopie übernehmen kann; Accounts am Limit oder ohne Anmeldung stehen am Ende. Woher die App das weiß: Claude Code schreibt ein erreichtes Limit mit Typ und Reset-Zeit ins Transcript, und unter `<config>/sessions/<pid>.json` steht, welche Session ein Prozess gerade offen hat. Neue Sessions startet die App mit `--session-id`, damit jeder Tab seine Session von Anfang an kennt.

Stand die Session am Limit, schickt die App nach dem Wechsel „Mach weiter“, damit Claude ohne Eingabe dort weitermacht, wo es aufgehört hat. Die Nachricht lässt sich unter *Einstellungen › Claude Code* ändern oder leeren (dann wird nichts geschickt). Beim Wechsel ohne Limit wird nie etwas geschickt. Was noch ungesendet im Eingabefeld stand, geht beim Wechsel verloren, weil Claude Code dafür beendet wird.

Die erste Antwort nach dem Wechsel kostet etwas mehr, weil der Prompt-Cache pro Account gilt und der andere Account den Verlauf einmal neu einliest.

## Account-Arten

| Art | Wie Claude Code gestartet wird | Usage-Limits |
| --- | --- | --- |
| **Standard** | normaler Login in `~/.claude` | live |
| **Eigener Login (OAuth)** | eigener Ordner unter `<userData>/profiles/<id>` als `CLAUDE_CONFIG_DIR`, Anmeldung im Browser per `claude auth login` | live |
| **Long-lived Token** | `CLAUDE_CODE_OAUTH_TOKEN=<Token aus claude setup-token>` | nicht abrufbar (die Usage-API lehnt diesen Token-Typ ab); lokale Statistik geht |
| **API-Key** | `ANTHROPIC_API_KEY=<sk-ant-api…>` | nicht zutreffend (Abrechnung nach Verbrauch) |

Bei Browser-Logins fragt die App Anthropic, zu welchem Konto und welcher Organisation der aktuelle Login gehört (`/api/oauth/profile`, eine Anfrage pro Zugangstoken). So stehen zwei Logins mit derselben E-Mail getrennt da, z. B. „name@firma.de · Firma“ (Team) und „name@firma.de · Persönlich“ (Pro/Max). Der Block `oauthAccount` in Claude Codes Konfiguration reicht dafür nicht: Wechselt ein Tool wie cswap den Login, kann eine noch laufende Claude-Code-Instanz den alten Block zurückschreiben. Wechselt der Login in einem Ordner, verwirft die App die alten Usage-Werte und fragt sofort neu ab.

Neue OAuth-Profile können `settings.json`, `keybindings.json`, `CLAUDE.md`, `skills`, `commands`, `agents` und `rules` aus `~/.claude` übernehmen. Sie werden einmalig kopiert, nicht verlinkt.

### Accounts aus cswap übernehmen

Ist [cswap](https://github.com/realiti4/claude-swap) installiert und kennt Accounts, zeigt die Accounts-Seite „Aus cswap importieren“. Ohne cswap erscheint der Knopf nicht. Die App liest dafür nur cswaps `sequence.json` (Alias, E-Mail, Organisation) und legt für jeden gewählten Account einen eigenen Browser-Login an. Name ist der Alias, sonst die E-Mail. Accounts, die es in der App schon gibt, sind markiert und nicht wählbar.

Danach meldest du jeden Account einmal über „Anmelden“ an, die E-Mail ist auf der Login-Seite schon eingetragen. cswaps gespeicherte Zugangsdaten liest die App nicht: Ein Refresh-Token lässt sich nur einmal verwenden, zwei Kopien desselben Logins würden sich gegenseitig abmelden. Gehört die E-Mail zu mehreren Organisationen und meldest du dich mit der falschen an, weist die Karte darauf hin. „Neu anmelden“ korrigiert das, „Ignorieren“ behält den Login.

## Sicherheit

- Tokens und API-Keys werden mit Windows DPAPI (Electron `safeStorage`) verschlüsselt gespeichert, nie im Klartext. Entschlüsselt werden sie einmal beim Start und nur im Speicher des Hauptprozesses gehalten. Die UI und die API zeigen nur eine maskierte Vorschau.
- Die App liest OAuth-Zugangsdaten nur, um die Usage und den Inhaber des Logins abzufragen. Sie erneuert oder verändert sie nie, das übernimmt Claude Code selbst. Im Cache steht nur ein Hash des Tokens, nicht der Token.
- Die lokale API ist standardmäßig aus. Eingeschaltet lauscht sie nur auf `127.0.0.1`, verlangt einen zufälligen Bearer-Token (ebenfalls DPAPI-verschlüsselt) und lehnt fremde `Host`-Header ab (Schutz vor DNS-Rebinding).

## Voraussetzungen

- Windows 11 22H2 oder neuer für Acryl/Mica. Mit der Material-Einstellung *Aus* ist der Hintergrund deckend.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installiert. Der Pfad wird automatisch erkannt oder in *Einstellungen → Claude Code* gesetzt.
- Für die Entwicklung: Node.js 22 oder neuer.

## Entwicklung

```powershell
npm install
npm run dev          # App mit Hot Reload starten
npm run typecheck    # Main/Preload (tsc) und Renderer (vue-tsc) prüfen
npm run build:win    # Typecheck, Build, cm.exe und NSIS-Installer → release/<version>/
```

`npx electron-builder --win --dir` erzeugt nur den entpackten Ordner `release/<version>/win-unpacked`. Das reicht zum schnellen Testen. Vorher einmal `npm run build:launcher` ausführen, das kompiliert `cm.exe` mit dem C#-Compiler aus dem .NET Framework 4, der bei Windows dabei ist.

## Projektstruktur

```
src/
  launcher/        cm.exe: Befehl für Terminal und Explorer-Adressleiste (C#)
  main/            Electron-Hauptprozess
    api/           lokale HTTP-API (Routen, OpenAPI, Doku-Seite, SSE)
    cli/           Aufrufe über cm auswerten, Befehl an- und abmelden
    services/      Accounts, Terminals (node-pty), Sessions, Usage, Einstellungen
    workers/       Worker-Thread zum Indexieren der Session-Transcripts
    window/        Fenster, Acryl/Mica (inkl. Fokus-Trick)
  preload/         typisierte Brücke window.api
  shared/          gemeinsame Typen, IPC-Kanäle, Defaults
  renderer/src/    Vue 3 + shadcn-vue
    components/    ui/ (shadcn-vue), common/, layout/, terminal/, sessions/, accounts/, dashboard/, settings/
    composables/   useTerminal, useLauncher, useShortcuts, useSetting, useSessionDetail, …
    stores/        Pinia: accounts, terminals, sessions, usage, settings, app, ui
    themes/        Theme-Definitionen
    views/         eine Seite pro Route
```

## Tastenkürzel

| Kürzel | Aktion |
| --- | --- |
| Strg+Umschalt+T | neue Session (Standard-Account) |
| Strg+Umschalt+W | Tab schließen (fragt nach, wenn der Prozess noch läuft) |
| Strg+Tab / Strg+Umschalt+Tab | nächster / vorheriger Tab |
| Strg+Umschalt+F | im Terminal suchen |
| Strg+Umschalt+P | Befehlspalette |
| Strg+, | Einstellungen |
| Strg+Plus / Strg+Minus / Strg+0 | Terminal-Schrift größer / kleiner / zurücksetzen |
| Umschalt+Enter | Zeilenumbruch im Claude-Code-Prompt |
| Strg+C | kopiert bei Auswahl, sonst Abbruch an den Prozess |
| Strg+V | einfügen; ein Bild aus der Zwischenablage (z. B. Screenshot) landet in Claude-Sessions als `[Image #N]` an der Cursorposition |

Alle anderen Strg-Kombinationen gehen unverändert an das Terminal, weil Claude Code selbst Strg+R, Strg+K usw. nutzt.

## Technische Hinweise

- **Acryl ohne Fokus**: Windows schaltet das Backdrop-Material ab, sobald ein Fenster inaktiv wird. Direkt nach dem Deaktivieren schickt die App `WM_NCACTIVATE` mit „aktiv“ an das eigene Fenster (`SendMessageW` über koffi). DWM zeichnet das Material dann weiter, ohne dass die App den Fokus stiehlt. Ist koffi nicht verfügbar, wird das Material beim Fokuswechsel normal ausgeblendet.
- **xterm-WebGL-Patch**: Das WebGL-Addon malt Zellen mit Hintergrund-Flags (z. B. gedimmter Text) immer deckend in der Theme-Hintergrundfarbe. Bei unserem transparenten Terminal-Hintergrund wären das schwarze Kästen. Ein kleines Vite-Plugin in `electron.vite.config.ts` korrigiert das beim Build. Passt der Patch nach einem Update nicht mehr, bricht der Build mit einer klaren Meldung ab.
- **node-pty**: Beim Schließen eines Terminals kann in der Konsole „AttachConsole failed“ erscheinen. Das ist bekanntes, harmloses Rauschen von node-pty 1.1.0: Die Prozesse werden trotzdem beendet, in der gepackten App sieht man nichts davon.
