# Lokale API

Mit der API steuern andere Programme Claude Manager: Accounts und Usage lesen, Sessions durchsuchen, Terminals öffnen, Eingaben senden und Ausgaben mitlesen.

Die vollständige Referenz mit allen Parametern, Schemas und curl-Beispielen liefert die App selbst. Sie wird aus derselben Routen-Tabelle erzeugt wie der Server und ist deshalb immer aktuell:

- `http://127.0.0.1:<port>/docs`: lesbare Doku (auch über *Einstellungen → API → Im Browser öffnen*)
- `http://127.0.0.1:<port>/openapi.json`: OpenAPI 3.1, z. B. für Postman, Insomnia oder Client-Generatoren

## Einschalten

*Einstellungen → API*: „API aktivieren“ einschalten. Standard-Port ist **47821**, er lässt sich dort ändern. Auf derselben Seite stehen Adresse und Token. Der Token lässt sich jederzeit neu erzeugen, danach sind alte Token und offene Event-Streams ungültig.

Die API läuft, solange die App läuft. Soll sie immer erreichbar sein, unter *Einstellungen → Claude Code → Start und Infobereich* „Im Infobereich weiterlaufen“ und „Mit Windows starten“ (unter Linux „Beim Anmelden starten“) einschalten: Die App startet dann beim Anmelden ohne Fenster, und Schließen blendet das Fenster nur aus.

## Sicherheit

- Der Server lauscht nur auf `127.0.0.1` und ist von anderen Rechnern nicht erreichbar.
- Jede Anfrage außer `/api/v1/health`, `/docs` und `/openapi.json` braucht `Authorization: Bearer <token>`.
- Anfragen mit einem anderen `Host` als `127.0.0.1:<port>` oder `localhost:<port>` werden mit 403 abgelehnt (Schutz vor DNS-Rebinding).
- CORS ist bewusst nicht aktiviert. Die API ist für lokale Programme und Skripte gedacht, nicht für Webseiten.
- Secrets (Tokens, API-Keys) liefert die API nie aus, nur eine maskierte Vorschau.

## Endpunkte

| Methode | Pfad | Zweck |
| --- | --- | --- |
| GET | `/api/v1/health` | Erreichbarkeit (ohne Token) |
| GET | `/api/v1/info` | App-, Electron- und Claude-Code-Version |
| GET | `/api/v1/accounts` | alle Accounts |
| GET | `/api/v1/accounts/{accountId}` | ein Account |
| GET | `/api/v1/accounts/{accountId}/stats?days=30` | Token-Verbrauch pro Tag und Modell |
| GET | `/api/v1/usage` | 5-Stunden- und Wochen-Limits aller Accounts |
| POST | `/api/v1/usage/refresh` | Limits jetzt neu abrufen |
| GET | `/api/v1/sessions?accountId=` | Sessions, gruppiert nach Account |
| GET | `/api/v1/sessions/{accountId}/{sessionId}?limit=600` | Verlauf einer Session: die neuesten `limit` Nachrichten, `total` zählt alle, `truncated` sagt, ob ältere fehlen |
| GET | `/api/v1/terminals` | offene Terminals |
| POST | `/api/v1/terminals` | Terminal öffnen (Session, Login oder Shell) |
| GET | `/api/v1/terminals/{id}` | ein Terminal |
| PATCH | `/api/v1/terminals/{id}` | Tab umbenennen (`{"title": "…"}`) oder stummschalten (`{"muted": true}`) |
| DELETE | `/api/v1/terminals/{id}` | Terminal schließen |
| POST | `/api/v1/terminals/{id}/input` | Eingabe senden (`{"data": "…"}`) |
| GET | `/api/v1/terminals/{id}/output?since=&tail=` | Ausgabe lesen |
| POST | `/api/v1/terminals/{id}/kill` | Prozess beenden, Tab bleibt offen |
| POST | `/api/v1/terminals/{id}/activate` | Tab in der App anzeigen |
| GET | `/api/v1/events?output=` | Live-Ereignisse (Server-Sent Events) |

Fehler kommen immer als `{"error": {"status": 404, "message": "…"}}`. Bodies sind JSON (`Content-Type: application/json`, höchstens 1 MB).

### Terminal öffnen

```json
POST /api/v1/terminals
{
  "accountId": "system",
  "cwd": "C:\\Projekte\\demo",
  "mode": "session",
  "resumeSessionId": null,
  "forkSession": false,
  "args": ["--model", "opus"],
  "title": "Mein Tab",
  "activate": true
}
```

Nur `accountId` ist Pflicht. `mode` ist `session` (Standard), `login` (`claude auth login`) oder `shell`. Mit `resumeSessionId` wird eine Session fortgesetzt, mit zusätzlich `"forkSession": true` als neue Session abgezweigt. `activate` holt die App nach vorn und zeigt den Tab.

Vertraut Claude Code dem Ordner für den Account noch nicht, fragt die App vorher in einem eigenen Dialog nach (statt Claude Code im Terminal) und trägt die Antwort in die `.claude.json` des Accounts ein. Die Antwort auf den Request kommt erst danach, bei „Abbrechen“ mit `403`.

Mit `authAccountId` läuft die Session über die Limits eines anderen Accounts: Die Dateien liegen weiter bei `accountId`, Claude Code bekommt aber Token oder API-Key von `authAccountId`. Das geht nur mit Token- und API-Key-Accounts, ein Browser-Login funktioniert nur im eigenen Ordner.

`title` ist der Titel der Claude-Code-Session wie in `/resume` (bei `/rename` der neue Name), solange es noch keinen gibt, der Ordner (bei einer Shell `Shell · Ordner`, bei einer Anmeldung `Anmeldung · Account`). Wird ein Tab mit `title` geöffnet oder umbenannt, bleibt der Titel fest (`fixedTitle: true`). Den Titel der Session gibt es dann weiter in `autoTitle`; ohne eigenen Namen ist er gleich `title`.

Jedes Terminal meldet außerdem `sessionId` (die Session, die gerade darin läuft), `authAccountId`, `busy` (Claude Code arbeitet gerade an einer Antwort) und `limit`. `limit` ist gesetzt, solange die Session an einem Nutzungslimit steht, mit `type` (z. B. `five_hour`), `resetsAt` und der Meldung von Claude Code. Über den `terminals`-Stream lässt sich so automatisch auf ein Limit reagieren.

`attention` zeigt, was im Tab passiert ist, seit er zuletzt in der App angezeigt wurde: `done` (Antwort fertig), `input` (Claude wartet auf eine Erlaubnis, eine Antwort oder die Freigabe eines Plans) oder `limit`, sonst `null`. `muted` ist gesetzt, wenn der Tab keine Benachrichtigungen schickt. Beides folgt den Einstellungen unter *Benachrichtigungen*; `muted` lässt sich beim Öffnen und per `PATCH` setzen.

Mit `hooks: true` meldet Claude Code seinen Zustand über Hooks an die App (Einstellung *Zustand über Hooks melden* unter *Werkzeuge*). Das Ende einer Antwort und Rückfragen kommen dann ohne Verzögerung, und drei Felder sind zusätzlich gefüllt:
- `activity`: das Werkzeug, das Claude gerade ausführt, mit `tool` (z. B. `Bash`), `detail` (Befehl, Datei …) und `since`. Es gilt nur, solange `busy` gesetzt ist.
- `subagents`: die Zahl der laufenden Subagents.
- `compacting`: Claude Code fasst gerade den Verlauf zusammen.

Ohne Hooks liest die App den Zustand aus Fenstertitel und Transcript. `activity` bleibt dann `null`, `subagents` `0` und `compacting` `false`.

`context` sagt, wie voll der Kontext einer Session ist, ab ihrem Start (bei Shells, Anmeldungen und Browser-Tabs `null`):
- `tokens`: Tokens im Kontext nach der letzten Antwort, nach einem Compact die Zusammenfassung; `null` vor der ersten Antwort.
- `compactAt`: ab hier fasst Claude Code den Verlauf von selbst zusammen, `null`, wenn Auto-Compact aus ist.
- `window`: das Auto-Compact-Fenster, per `/autocompact` gesetzt (`configured: true`), sonst das Kontextfenster des Modells. `compactAt` liegt 33k darunter, als Platz für Antwort und Zusammenfassung.
- `model`: z. B. `claude-opus-5-5`, vor der ersten Antwort das in Claude Code gewählte Modell.

Browser-Tabs der App stehen mit in der Liste, mit `mode: "browser"` und der angezeigten Adresse in `url` (bei Terminals `null`). Sie haben keinen Prozess, keinen Account und keinen Ordner: Eingaben, Ausgabe und `kill` bewirken bei ihnen nichts, umbenennen, aktivieren und schließen geht wie bei Terminals. Geöffnet werden sie in der App.

### Ausgabe lesen

Die Ausgabe eines Terminals ist ein fortlaufender Stream mit Zeichen-Offsets. `GET …/output` liefert `{"data", "start", "end", "truncated"}`:

- `since=<end der letzten Antwort>` liefert nur, was seitdem dazugekommen ist.
- `tail=<n>` liefert höchstens die letzten `n` Zeichen.
- `truncated: true` heißt, dass ältere Ausgabe nicht mehr im Puffer liegt.

Die Daten enthalten die rohen ANSI-Escape-Sequenzen, so wie Claude Code sie ausgibt.

### Event-Stream

`GET /api/v1/events` hält die Verbindung offen und sendet:

| Event | Daten |
| --- | --- |
| `terminals` | Liste aller Terminals (sofort beim Verbinden und bei jeder Änderung) |
| `terminal-exit` | `{"id", "exitCode"}` |
| `terminal-output` | `{"id", "data", "offset"}` für die per `?output=<id1>,<id2>` gewählten Terminals |
| `accounts` | Liste aller Accounts |
| `usage` | Limits aller Accounts |
| `sessions` | `{"accountId"}`, wenn sich Sessions eines Accounts geändert haben |

Alle 25 Sekunden kommt ein Kommentar (`: ping`) als Keep-Alive. Weil `EventSource` keine Header setzen kann, ist der Token hier auch als `?access_token=` erlaubt, aber nur bei diesem Endpunkt.

## Beispiele

### curl

```bash
TOKEN="<Token aus Einstellungen → API>"
BASE="http://127.0.0.1:47821"

curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/usage"

# Shell öffnen, Befehl senden, Ausgabe lesen
ID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"accountId":"system","mode":"shell"}' "$BASE/api/v1/terminals" | jq -r .id)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"data":"Get-Date\r"}' "$BASE/api/v1/terminals/$ID/input"
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/terminals/$ID/output?tail=2000"

# Live mitlesen
curl -N -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/events?output=$ID"
```

### PowerShell

```powershell
$headers = @{ Authorization = "Bearer $env:CLAUDE_MANAGER_TOKEN" }
$base = 'http://127.0.0.1:47821'

Invoke-RestMethod "$base/api/v1/usage" -Headers $headers |
  Select-Object accountId, @{ n = '5h %'; e = { $_.fiveHour.percent } }, @{ n = 'Woche %'; e = { $_.sevenDay.percent } }

$body = @{ accountId = 'system'; cwd = 'C:\Projekte\demo'; activate = $true } | ConvertTo-Json
Invoke-RestMethod "$base/api/v1/terminals" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

### Node.js (ab Version 18)

```js
const base = 'http://127.0.0.1:47821'
const headers = { Authorization: `Bearer ${process.env.CLAUDE_MANAGER_TOKEN}` }

const sessions = await fetch(`${base}/api/v1/sessions`, { headers }).then((r) => r.json())
for (const group of sessions) console.log(group.accountId, group.sessions.length)

// Event-Stream lesen
const res = await fetch(`${base}/api/v1/events`, { headers })
const decoder = new TextDecoder()
for await (const chunk of res.body) process.stdout.write(decoder.decode(chunk, { stream: true }))
```
