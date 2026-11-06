# Claude Manager

Desktop-App für Windows 11 und Linux, die mehrere Claude-Code-Instanzen nebeneinander verwaltet: Terminals in Tabs, mehrere Accounts gleichzeitig, eine durchsuchbare Session-Liste (wie `/resume`, gruppiert nach Account), ein Usage-Dashboard und eine lokale API für andere Programme.

## Funktionen

- **Terminals**: xterm.js (WebGL) mit ConPTY bzw. einem Pseudo-Terminal unter Linux. Farben, Emoji inkl. ZWJ-Sequenzen, Box-Drawing und Nerd-Font-Icons werden korrekt dargestellt. Tabs bleiben beim Seitenwechsel erhalten und lassen sich per Drag & Drop umsortieren, oben in der Titelleiste wie in der Seitenleiste. Wird es eng, werden sie schmaler wie im Browser. Suche, Zoom, Kopieren/Einfügen, Umschalt+Enter für Zeilenumbrüche in Claude Code. Dateien lassen sich ins Terminal ziehen: Wie in Windows Terminal wird ihr Pfad eingefügt, Bilder hängt Claude Code dann an. Beendest du Claude mit Strg+C oder `/exit` (bzw. die Shell mit `exit`), schließt sich der Tab. Bei einem Fehler bleibt er offen, einstellbar unter Einstellungen › Claude Code. Auf Wunsch merkt sich die App die offenen Tabs und öffnet sie beim nächsten Start in derselben Reihenfolge wieder, Claude-Sessions werden dabei fortgesetzt (Einstellungen › Claude Code › Tabs beim Start wiederherstellen).
- **Accounts**: beliebig viele Accounts parallel, auch mehrere Tabs mit demselben Account. Ist ein Account am Limit, läuft die Session mit einem anderen weiter (siehe unten). Accounts aus cswap lassen sich übernehmen.
- **Sessions**: alle gespeicherten Claude-Code-Sessions, gruppiert nach Account. Suche über Titel, ersten und letzten Prompt, Ordner, Git-Branch und Session-ID, Verlauf mit Markdown und Tool-Aufrufen, die sich aufklappen lassen: vollständige Eingabe und Ergebnis, Fehler rot markiert. Fortsetzen per Doppelklick oder als neue Session abzweigen (`--fork-session`). Filter zeigen nur Sessions der letzten Tage oder solche, die älter sind als eine Woche bis ein Jahr, und nach Größe des Verlaufs die großen (über 1, 10 oder 50 MB) oder die fast leeren (unter 10 KB bis 1 MB). Anzahl und Gesamtgröße der gefilterten Sessions stehen daneben. Mit *Mehrere auswählen* (oder Strg+Klick) lassen sich Sessions markieren, mit Umschalt+Klick als Bereich, und gesammelt löschen, einzelne auch über das Kontextmenü. Sie kommen samt Subagents und `/rewind`-Ständen in den Papierkorb und lassen sich dort wiederherstellen. Sessions, die in einem Tab offen sind oder gerade in Claude Code laufen, bleiben. Der Token-Verbrauch im Dashboard wird aus den Transcripts berechnet, gelöschte Sessions fehlen dort danach.
- **Usage-Dashboard**: 5-Stunden- und Wochen-Limits (live, wie bei [cswap](https://github.com/realiti4/claude-swap), auch für Accounts, die gerade nicht genutzt werden: ihr abgelaufener Zugangstoken wird dafür erneuert) sowie Token-Verbrauch pro Tag und Modell, berechnet aus den lokalen Transcripts. Ist der Login von `~/.claude` schon als eigener Account hinterlegt (etwa nach dem cswap-Import), lassen Dashboard und Accounts-Seite den Standard-Account weg, damit dieselben Limits nicht doppelt erscheinen. Auf der Accounts-Seite lässt er sich über den Hinweis unter den Karten wieder einblenden. Die Limits des Accounts im aktiven Tab stehen außerdem in der Titelleiste, ein Klick zeigt Details und Reset-Zeiten. Balken und Ringe sind grün (unter 60 %), orange (ab 60 %) und rot (ab 85 %), in den Farben des gewählten Themes.
- **Befehl `cm`**: öffnet eine Claude-Session im Manager, aus jedem Terminal oder unter Windows direkt aus der Explorer-Adressleiste (siehe unten).
- **Darstellung**: unter Windows Acryl, Mica oder Mica Alt, auch wenn das Fenster nicht im Fokus ist (unter Linux ist das Fenster deckend). 11 Themes (u. a. Catppuccin, Tokyo Night, Rosé Pine, Nord, Dracula). Das Terminal folgt dem Theme oder bekommt ein eigenes Farbschema. Claude Codes Theme „Auto (match terminal)“ folgt mit, auch beim Wechsel zwischen hell und dunkel in einer laufenden Session. Schrift, Größe, Zeilenhöhe, Cursor usw. lassen sich mit Live-Vorschau einstellen. Seitenleisten von Claude Code wie `/diff` bekommen statt ihres festen Graus die Flächenfarbe des Themes oder den Terminal-Hintergrund (Einstellungen › Terminal). Die Tabs stehen wahlweise oben in der Titelleiste oder untereinander in der Seitenleiste, deren Symbole dann auch beschriftet sind (Einstellungen › Darstellung › Tabs).
- **Einstellungen sichern**: *Exportieren* oben in den Einstellungen speichert alle Einstellungen in einer JSON-Datei, *Importieren* übernimmt sie, etwa auf einem anderen Computer. Accounts und Anmeldedaten gehören nicht dazu, auch der Standard-Account bleibt, wie er ist. Pfade zur `claude.exe` oder zum Standard-Arbeitsordner, die es auf diesem Computer nicht gibt, werden nicht übernommen. Einstellungen, die die Datei nicht kennt (z. B. aus einer älteren Version), behalten ihren Wert. Direkt nach dem Import lässt er sich in der Meldung rückgängig machen.
- **Lokale API**: REST + Server-Sent Events auf `127.0.0.1`, Doku unter `/docs`, OpenAPI 3.1 unter `/openapi.json`. Siehe [docs/API.md](docs/API.md).
- **Benachrichtigungen**: Ist Claude in einem Tab fertig, wartet es auf deine Erlaubnis für ein Tool, auf die Antwort auf eine Frage oder auf die Freigabe eines Plans, oder steht die Session an einem Limit, weist die App darauf hin. Eine Windows-Benachrichtigung (unter Linux die des Desktops) nennt Tab und Ereignis, auf Wunsch mit dem Anfang der Antwort, dem Befehl, der auf Erlaubnis wartet, oder Claudes Frage; ein Klick öffnet den Tab. Dazu blinkt die Taskleiste, und Tabs mit Neuigkeiten, die du noch nicht gesehen hast, bekommen einen Punkt (orange, wenn Claude auf dich wartet). Alles ist einstellbar unter *Einstellungen › Benachrichtigungen*: welche Ereignisse, ob nur bei Fenster im Hintergrund oder auch, wenn ein anderer Tab offen ist, eine Mindestdauer für fertige Antworten, Vorschau, Ton, Blinken und Punkt. Erreicht ein Limit eines Accounts eine einstellbare Schwelle (Standard 80 %), kommt eine Warnung mit Account, Limit und Reset-Zeit, einmal pro Account und Zeitraum, auch über einen Neustart hinweg; ein Klick öffnet das Usage-Dashboard. Die Glocke oben rechts in der Titelleiste schaltet alles mit einem Klick an und aus, einzelne Tabs lassen sich über ihr Kontextmenü stummschalten. Erkannt wird das Ende eines Turns am Fenstertitel, den Claude Code setzt (`◐`/`◑` beim Arbeiten, `✳` im Leerlauf), der Grund steht im Transcript. Weil Claude Code dort gepuffert schreibt, kommt der Hinweis 1 bis 5 Sekunden nach dem Ende.
- **Im Hintergrund**: Auf Wunsch läuft sie im Infobereich weiter: Schließen blendet das Fenster nur aus, Terminals und API laufen weiter, beendet wird über das Kontextmenü des Symbols. Zusammen mit „Mit Windows starten“ (unter Linux „Beim Anmelden starten“) startet sie beim Anmelden ohne Fenster, die API ist also immer erreichbar (Einstellungen › Claude Code › Start und Infobereich). Die Deinstallation entfernt den Autostart wieder.
- **Befehlspalette** (Strg+Umschalt+P) für Aktionen, Navigation, offene Tabs und die letzten Sessions.
- **Updates**: Die App sucht beim Start und alle 4 Stunden nach einer neuen Version (GitHub-Releases). Ein Update wird mit einem Klick geladen und beim Neustart installiert, laufende Terminals werden vorher abgefragt. Im Tab *Updates* der Einstellungen stehen die Versionshinweise aller Versionen, „Details“ zeigt darunter die Beschreibung des Pull Requests von GitHub. Ein Punkt am Zahnrad in der Navigationsleiste zeigt ein wartendes Update oder ungelesene Neuerungen, ein Klick darauf öffnet dann direkt die Updates.

## Installation

Die Dateien stehen bei jedem [Release](https://github.com/qzconnor/claude-manager/releases/latest) auf GitHub.

- **Windows 11**: `Claude-Manager-<version>-Setup.exe` ausführen.
- **Debian, Ubuntu, Linux Mint, Pop!_OS**: `sudo apt install ./Claude-Manager-<version>.deb`. Die App steht danach im Anwendungsmenü und unter `/opt/Claude Manager`, auf der Kommandozeile als `claude-manager`.
- **Fedora, openSUSE, RHEL**: `sudo dnf install ./Claude-Manager-<version>.rpm` (openSUSE: `sudo zypper install ./…`).
- **Alle anderen Distributionen**: `Claude-Manager-<version>.AppImage` herunterladen, mit `chmod +x Claude-Manager-*.AppImage` ausführbar machen und starten. Es braucht kein libfuse2, nur FUSE 3 (`fusermount3`), das jede aktuelle Distribution mitbringt. Ins Anwendungsmenü kommt es z. B. mit [Gear Lever](https://flathub.org/apps/it.mijorus.gearlever) oder AppImageLauncher.

Updates holt sich die App selbst: Das AppImage ersetzt seine eigene Datei, das deb- und rpm-Paket installiert die App über den Paketmanager, der dafür einmal nach dem Passwort fragt.

## Befehl `cm`

Der Installer richtet den Befehl `cm` ein, unter Linux die App bei ihrem ersten Start. Wie `cmd` funktioniert er auch in der Adressleiste des Explorers: `cm` eintippen, Enter, und im Manager öffnet sich eine Session im angezeigten Ordner. Läuft die App noch nicht, startet sie. Ist der Ordner schon in einem Tab offen, wechselt `cm` nur zu diesem Tab, auch wenn er gerade beim Start wiederhergestellt wurde (abschaltbar unter *Einstellungen → Claude Code*).

| Aufruf | Wirkung |
|---|---|
| `cm` | Session im aktuellen Ordner mit dem Standard-Account |
| `cm <ordner>` | Session in `<ordner>` (relativ zum aktuellen Ordner, `~` = Benutzerordner) |
| `cm -a <account>` | mit Account: Name, E-Mail, ID oder ein eindeutiger Teil des Namens |
| `cm -c` | letzte Session in diesem Ordner fortsetzen (`claude --continue`) |
| `cm -r [session-id]` | Session fortsetzen, ohne ID mit der Auswahl von Claude Code |
| `cm -s` | PowerShell (Linux: die Login-Shell) mit der Umgebung des Accounts statt Claude Code |
| `cm -n` | immer einen neuen Tab öffnen, auch wenn der Ordner schon offen ist |
| `cm -- <argumente>` | Argumente an `claude` weitergeben, z. B. `cm -- --model opus` |
| `cm -h` | Hilfe |

Technisch ist `cm.exe` ein kleiner Launcher (`src/launcher/cm.cs`), der Ordner und Argumente an die laufende App weiterreicht. Er liegt im Unterordner `bin` der Installation, nur dieser Ordner kommt in den Benutzer-PATH. Für die Explorer-Adressleiste trägt der Installer zusätzlich einen App-Pfad unter `HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\cm.exe` ein. Admin-Rechte braucht beides nicht. Die Deinstallation entfernt beides wieder, der restliche PATH bleibt unverändert. In *Einstellungen → Claude Code* lässt sich der Befehl auch nachträglich an- und abmelden.

Unter Linux schreibt die App ein kleines Shell-Skript nach `~/.local/bin/cm` (`src/main/cli/linux-launcher.ts`). Es enthält den Pfad der App, beim AppImage den der AppImage-Datei, und die App hält ihn bei jedem Start aktuell, auch wenn das AppImage verschoben wurde. Ein `cm` eines anderen Programms überschreibt sie nie. `~/.local/bin` steht bei den meisten Distributionen im PATH, sonst weist die Einstellungsseite darauf hin. Hast du den Befehl dort abgemeldet, richtet ihn auch ein späterer Start nicht wieder ein.

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

- Tokens und API-Keys werden mit Windows DPAPI bzw. unter Linux mit dem Schlüsselbund verschlüsselt gespeichert (Electron `safeStorage`), nie im Klartext. Unter KDE ist das KWallet, auf allen anderen Desktops der Secret Service (GNOME Keyring, KeePassXC u. a.), auch dort, wo Chromium ihn von sich aus nicht nimmt (sway, Hyprland, i3, MATE, LXQt). Mit `--password-store=…` lässt sich das wie in Chromium überschreiben. Gibt es unter Linux keinen Schlüsselbund, speichert die App keine Tokens und API-Keys, statt auf Chromiums festen Schlüssel auszuweichen. Browser-Logins brauchen keinen, ihre Zugangsdaten verwaltet Claude Code selbst. Entschlüsselt werden sie einmal beim Start und nur im Speicher des Hauptprozesses gehalten. Die UI und die API zeigen nur eine maskierte Vorschau.
- Die App liest OAuth-Zugangsdaten nur, um die Usage und den Inhaber des Logins abzufragen. Ist der Zugangstoken eines Browser-Logins abgelaufen, erneuert sie ihn mit dem Refresh-Token, so wie Claude Code beim Start einer Session: unter Claude Codes eigener Sperre für den Ordner (`.oauth_refresh.lock`), und geschrieben wird nur, wenn in `.credentials.json` noch derselbe Refresh-Token steht. So verwenden App und Claude Code nie denselben Refresh-Token zweimal. Sonst verändert die App die Zugangsdaten nicht. Im Cache steht nur ein Hash des Tokens, nicht der Token.
- Die lokale API ist standardmäßig aus. Eingeschaltet lauscht sie nur auf `127.0.0.1`, verlangt einen zufälligen Bearer-Token (ebenfalls verschlüsselt, ohne Schlüsselbund gilt er nur bis zum Beenden) und lehnt fremde `Host`-Header ab (Schutz vor DNS-Rebinding).

## Voraussetzungen

- Windows 11 22H2 oder neuer für Acryl/Mica. Mit der Material-Einstellung *Aus* ist der Hintergrund deckend.
- Linux x64 mit X11 oder Wayland, z. B. Ubuntu 22.04, Debian 12, Fedora 40 oder neuer. Das Symbol im Infobereich zeigt GNOME erst mit der Erweiterung „AppIndicator“ (bei Ubuntu dabei).
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installiert. Der Pfad wird automatisch erkannt oder in *Einstellungen → Claude Code* gesetzt.
- Für die Entwicklung: Node.js 22 oder neuer.

## Entwicklung

```powershell
npm install
npm run dev          # App mit Hot Reload starten
npm run typecheck    # Main/Preload (tsc) und Renderer (vue-tsc) prüfen
npm test             # Unit-Tests (Vitest), `npm run test:watch` läuft bei Änderungen mit
npm run build:win    # Typecheck, Build, cm.exe und NSIS-Installer → release/<version>/
npm run build:linux  # unter Linux: Typecheck, Build, AppImage, deb und rpm → release/<version>/
```

Die Linux-Pakete lassen sich nur unter Linux bauen, weil node-pty dort keine fertigen Binärdateien mitbringt: `npm install` kompiliert es (dafür `python3`, `make` und `g++`; `allowScripts` in der package.json erlaubt das auch unter npm 12, das Install-Skripte sonst blockiert), für das rpm-Paket braucht es zusätzlich `rpmbuild` (Paket `rpm`). Ohne Linux-Rechner geht es z. B. in WSL oder im Container `node:24-bookworm`.

Die Tests liegen als `*.test.ts` neben ihrem Modul und prüfen die Logik, die ohne Electron und Fenster auskommt: Parser für Transcripts, Fenstertitel und die Usage-API, Regeln wie die Limit-Warnung, Hilfsfunktionen und Themes. Beispieldaten sind kleine, anonymisierte Ausschnitte im Format von Claude Code. CI führt sie bei jedem Pull Request unter Windows und Linux aus.

`npm run dev` und `npm start` nutzen ein eigenes Profil (`%APPDATA%\Claude Manager Dev`), damit sie neben der installierten App laufen. Einstellungen und Accounts sind dort getrennt, der Standard-Account (`~/.claude`) ist immer da.

`npx electron-builder --win --dir` erzeugt nur den entpackten Ordner `release/<version>/win-unpacked`. Das reicht zum schnellen Testen. Vorher einmal `npm run build:launcher` ausführen, das kompiliert `cm.exe` mit dem C#-Compiler aus dem .NET Framework 4, der bei Windows dabei ist.

### Releases

Jeder Push auf `master` startet [semantic-release](https://semantic-release.gitbook.io/) (`.github/workflows/release.yml`). Es liest die Version aus den Commit-Nachrichten ([Conventional Commits](https://www.conventionalcommits.org/de/)). Mit ihr bauen ein Windows- und ein Linux-Runner den Installer bzw. AppImage, deb und rpm, danach veröffentlicht semantic-release alles zusammen mit den Versionshinweisen als GitHub-Release. Von dort holt sich die installierte App ihre Updates.

| Commit | Version | Versionshinweise |
| --- | --- | --- |
| `feat: …` | neue Minor-Version | „Neue Funktionen“ |
| `fix: …` | neue Patch-Version | „Fehlerbehebungen“ |
| `perf: …` | neue Patch-Version | „Schneller“ |
| `feat!: …` oder `BREAKING CHANGE:` im Text | neue Major-Version | |
| `docs:`, `ci:`, `build:`, `chore:`, `refactor:`, `style:`, `test:` | kein Release | nicht aufgeführt |

Pull Requests per Squash-Merge zusammenführen: Dann wird ihr Titel zur Commit-Nachricht. Deshalb prüft `pr-title.yml` den Titel, und `ci.yml` baut den Installer und die Linux-Pakete einmal zur Probe. Die Version in `package.json` bleibt im Repository unverändert: semantic-release setzt sie nur für den Build.

## Projektstruktur

```
src/
  launcher/        cm.exe: Befehl für Terminal und Explorer-Adressleiste (C#, Windows)
  main/            Electron-Hauptprozess
    api/           lokale HTTP-API (Routen, OpenAPI, Doku-Seite, SSE)
    cli/           Aufrufe über cm auswerten, Befehl an- und abmelden, cm-Skript für Linux
    services/      Accounts, Terminals (node-pty), Sessions, Usage, Einstellungen, Updates
    workers/       Worker-Thread zum Indexieren der Session-Transcripts
    window/        Fenster, Acryl/Mica (inkl. Fokus-Trick)
  preload/         typisierte Brücke window.api
  shared/          gemeinsame Typen, IPC-Kanäle, Defaults
  renderer/src/    Vue 3 + shadcn-vue
    components/    ui/ (shadcn-vue), common/, layout/, terminal/, sessions/, accounts/, dashboard/, settings/, updates/
    composables/   useTerminal, useLauncher, useShortcuts, useSetting, useSessionDetail, …
    stores/        Pinia: accounts, terminals, sessions, usage, settings, updates, app, ui
    themes/        Theme-Definitionen
    views/         eine Seite pro Route
```

## Tastenkürzel

| Kürzel | Aktion |
| --- | --- |
| Strg+Umschalt+T | neue Session (Standard-Account) |
| Strg+Umschalt+W | Tab schließen (fragt nach, wenn der Prozess noch läuft) |
| Strg+Tab / Strg+Umschalt+Tab | nächster / vorheriger Tab |
| Strg+1 … Strg+8 / Strg+9 | Tab 1 bis 8 / letzter Tab |
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
- **Umgebung unter Linux**: Aus dem Anwendungsmenü gestartet, kennt die App nur die Umgebung der Desktop-Sitzung, ohne das, was `~/.bashrc` oder `~/.zshrc` einrichten (z. B. nvm, `~/.npm-global`, `~/.bun`). Wie VS Code fragt sie deshalb beim Start einmal die Login-Shell nach ihrer Umgebung und übernimmt sie (`src/main/lib/shell-env.ts`), so findet sie `claude` auch dort. Variablen, die das AppImage nur für sich selbst setzt, bekommen Terminals nicht mit.
- **Chromium-Sandbox unter Linux**: Das deb- und rpm-Paket richten die Sandbox bei der Installation ein (unter Ubuntu 24.04 mit einem AppArmor-Profil). Das AppImage prüft beim Start, ob Benutzer-Namespaces erlaubt sind, und startet sonst ohne Sandbox, statt abzustürzen.
- **Theme „Auto“ von Claude Code**: Claude Code fragt die Hintergrundfarbe des Terminals ab (OSC 11) und hört auf Meldungen, wenn das Terminal zwischen hell und dunkel wechselt (Modus 2031, `CSI ? 997 ; 1/2 n`). Die ConPTY von Windows schluckt die Farbabfrage, deshalb starten neue Tabs unter Windows mit der ConPTY aus Windows Terminal, die node-pty mitbringt (*Einstellungen › Terminal › ConPTY aus Windows Terminal*). Die Abfrage beantwortet die App mit dem Hintergrund des Themes (xterm selbst würde den transparenten Hintergrund melden, also Schwarz), und bei einem Wechsel bekommen die Programme, die Modus 2031 eingeschaltet haben, die Meldung. Neue Tabs bekommen außerdem `COLORFGBG`, damit Claude Code auch mit der ConPTY von Windows wenigstens beim Start richtig wählt.
- **node-pty**: Beim Schließen eines Terminals kann in der Konsole „AttachConsole failed“ erscheinen. Das ist bekanntes, harmloses Rauschen von node-pty 1.1.0: Die Prozesse werden trotzdem beendet, in der gepackten App sieht man nichts davon.
