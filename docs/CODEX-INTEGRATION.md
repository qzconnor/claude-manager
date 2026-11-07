# Idee: Codex CLI integrieren

Stand der Prüfung: 07.11.2026. Noch nicht umgesetzt, nur geprüft, ob und mit welchem Aufwand [OpenAI Codex CLI](https://github.com/openai/codex) neben Claude Code in die App passt.

**Ergebnis:** Machbar. Codex ist ähnlich gebaut wie Claude Code (CLI im Terminal, Login pro Config-Ordner, Sessions als JSONL-Dateien, MCP, Hooks). Fast alle Funktionen der App lassen sich übertragen, auch Usage und Limits. Die Arbeit steckt vor allem darin, die Claude-spezifischen Stellen der App hinter eine gemeinsame Schnittstelle zu legen und einen zweiten Parser für die Sessiondateien zu schreiben.

## Codex auf einen Blick

| Thema | Codex | Entspricht bei Claude Code |
|---|---|---|
| Installation | `npm i -g @openai/codex` oder Installer (`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`), Binary `codex`, nativ unter Windows (kein WSL nötig) | `claude` |
| Config-Ordner | `CODEX_HOME` (Standard `~/.codex`), enthält `auth.json`, `config.toml`, `sessions/`. Der Ordner muss existieren. | `CLAUDE_CONFIG_DIR` |
| Login | `codex login` (Browser), `--device-auth`, `--with-api-key` (über stdin), `codex login status`, `codex logout` | `claude auth login` |
| Login-Speicher | `cli_auth_credentials_store = "file" \| "keyring" \| "auto" \| "ephemeral"` in `config.toml` | `.credentials.json` |
| Fortsetzen | `codex resume <id>`, `--last`, `--all` | `--resume` |
| Abzweigen | `codex fork <id>`, auch `--worktree` | `--fork-session` |
| Session-ID vorgeben | In der Doku nicht gefunden | `--session-id` |
| MCP | `[mcp_servers.<name>]` mit `command`, `args`, `env` bzw. `url` in `config.toml`, pro Start über `-c key=value` überschreibbar | `--mcp-config` |
| Hooks | `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, `Interrupt`, `PreCompact`, … in `hooks.json` oder `config.toml`. Bekommen JSON mit `session_id`, `transcript_path`, `cwd` auf stdin. Eigene Hooks laufen erst nach Bestätigung (Trust). | Hooks in `settings.json` |
| Benachrichtigung | `notify = ["befehl", …]` bekommt JSON-Payload (Format nicht dokumentiert) | – |
| Programmatisch | `codex exec --json` (JSONL-Events), `codex app-server` (JSON-RPC über stdio, u. a. `thread/start`, `thread/resume`, `turn/start`, `account/rateLimits/read`), TypeScript-SDK `@openai/codex-sdk` | `claude -p`, Agent SDK |
| Sandbox / Freigaben | `-s read-only \| workspace-write \| danger-full-access`, `-a on-request \| never`, unter Windows eigene Sandbox (`mxc`, `elevated`, `unelevated`) | Permission-Modes |

Quellen: [Doku-Startseite](https://learn.chatgpt.com/docs/codex/cli), [Umgebungsvariablen](https://learn.chatgpt.com/docs/config-file/environment-variables), [Befehle](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [Config-Referenz](https://learn.chatgpt.com/docs/config-file/config-reference), [MCP](https://learn.chatgpt.com/docs/extend/mcp), [Hooks](https://learn.chatgpt.com/docs/hooks), [App-Server](https://learn.chatgpt.com/docs/app-server), [Nicht-interaktiv](https://learn.chatgpt.com/docs/non-interactive-mode), [SDK](https://learn.chatgpt.com/docs/codex-sdk), [Login](https://learn.chatgpt.com/docs/auth), [Windows-Sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox).

## Sessiondateien (lokal geprüft)

Das Format ist **nicht dokumentiert**. Geprüft an drei lokalen Sessions aus der VS-Code-Erweiterung (Codex 0.61, Sept. und Dez. 2025):

- Pfad: `$CODEX_HOME/sessions/JJJJ/MM/TT/rollout-<Zeitstempel>-<uuid>.jsonl`
- Jede Zeile: `{ "timestamp", "type", "payload" }`
- Erste Zeile `session_meta`: `id`, `timestamp`, `cwd`, `originator`, `cli_version`, `source`, `model`, …
- Weitere Typen: `turn_context`, `response_item` (`message`, `reasoning`, `function_call`, `function_call_output`, `ghost_snapshot`), `event_msg` (`user_message`, `agent_message`, `agent_reasoning`, `token_count`)
- Ein Ereignis für „Antwort fertig“ gab es in diesen Dateien nicht.

`token_count` kommt nach jeder Antwort und enthält Usage und Limits:

```json
{
  "type": "token_count",
  "info": {
    "total_token_usage": { "input_tokens": 257878, "cached_input_tokens": 214144, "output_tokens": 10044, "reasoning_output_tokens": 8768, "total_tokens": 267922 },
    "last_token_usage": { "input_tokens": 22435, "cached_input_tokens": 21632, "output_tokens": 5172, "reasoning_output_tokens": 4864, "total_tokens": 27607 },
    "model_context_window": 258400
  },
  "rate_limits": {
    "primary":   { "used_percent": 3.0, "window_minutes": 300,   "resets_at": 1764597322 },
    "secondary": { "used_percent": 1.0, "window_minutes": 10080, "resets_at": 1765184122 },
    "credits":   { "has_credits": false, "unlimited": false, "balance": "0" }
  }
}
```

Die Dateien vom September haben noch kein `rate_limits`, erst die vom Dezember. Ältere Codex-Versionen liefern also keine Limits.

## Was mit Codex ginge

| Funktion der App | Mit Codex | Wie |
|---|---|---|
| Tabs, geteilte Tabs | Ja | `codex` im PTY starten |
| Mehrere Accounts | Ja | Eigener `CODEX_HOME` pro Account |
| Sessionübersicht, Detailansicht, Suche | Ja | Zweiter Parser für die Rollout-Dateien |
| Fortsetzen, Abzweigen | Ja | `codex resume <id>`, `codex fork <id>` |
| Tab-Titel aus der Session | Wohl ja | Erste Nutzernachricht |
| 5-Stunden- und Wochenlimit, Reset-Zeit | Ja | `rate_limits` aus `token_count` |
| Prognose, wann ein Limit erreicht ist | Ja | Gleiche Datenform wie bei Claude |
| Tokens nach Ordner und Tag im Dashboard | Ja | `total_token_usage` / `last_token_usage` + `cwd` |
| Füllstand des Kontextfensters | Ja | `model_context_window` |
| Credits / Guthaben | Ja | `rate_limits.credits` (gibt es bei Claude so nicht) |
| Beschäftigt / wartet / Benachrichtigungen | Ja | Hooks `UserPromptSubmit`, `Stop`, `PermissionRequest` |
| Browser-Werkzeuge (MCP) | Wahrscheinlich | `-c mcp_servers.claude-manager.…` beim Start, ungetestet |
| App-Kontext („du läufst in Claude Manager“) | Unklar | Passende Option für Systemprompt noch suchen |
| Git-Worktree für neue Sessions | Ja | Macht die App selbst mit Git |
| Account-Wechsel am Limit | Teilweise | Erkennen geht, dann Rollout-Datei in den anderen `CODEX_HOME` kopieren und dort fortsetzen |
| Wechsel zwischen Claude und Codex mitten in einer Session | Nein | Formate nicht kompatibel |
| Login erneuern | Nicht nötig | Codex erneuert selbst |

**Unterschied bei Usage:** Claude-Limits holt die App jederzeit über die Anthropic-API. Codex-Limits stehen nur in den Sessiondateien, also nur so aktuell wie die letzte Antwort. Abgelaufene Fenster kann die App anhand von `resets_at` trotzdem auf 0 % setzen. Für Werte ohne laufende Session: `codex app-server` mit `account/rateLimits/read` und der Benachrichtigung `account/rateLimits/updated` (ca. 1–2 Tage zusätzlich). Mit API-Key statt ChatGPT-Login gibt es vermutlich keine Planlimits, nur Tokens.

## Wo die App heute an Claude Code hängt

| Stelle | Claude-spezifisch |
|---|---|
| `src/main/services/claude-cli.ts` | Findet und startet `claude` |
| `src/main/services/terminal-service.ts` (`create`) | Baut `--session-id`, `--resume`, `--fork-session`, erkennt Session-Argumente |
| `src/main/browser/mcp-server.ts` | Browser-MCP über `--mcp-config` |
| `src/main/services/app-context.ts` | App-Kontext über `--append-system-prompt-file` |
| `src/main/lib/terminal-title.ts` (`claudeActivity`) | Beschäftigt/fertig am Spinner im Fenstertitel |
| `src/main/lib/claude-paths.ts`, `src/main/lib/session-files.ts` | Pfade und Sessiondateien unter `~/.claude/projects` |
| `src/main/workers/transcript-parser.ts`, `search-index.ts`, `indexer.worker.ts` | Claude-Transcriptformat |
| `src/main/services/usage-service.ts`, `oauth-renewal.ts` | Anthropic-OAuth-Usage-API |
| `src/main/services/account-service.ts`, `login-profiles.ts` | `CLAUDE_CONFIG_DIR`, Account-Arten oauth/token/apiKey, übernommene Dateien aus `~/.claude` |
| `src/main/services/auto-switch.ts`, `session-handoff.ts` | Wechsel am Limit für Claude-Sessions |
| `src/main/services/notification-service.ts` | Liest Claude-Transcripts für den Text der Benachrichtigung |
| `src/main/lib/workspace-trust.ts` | Vertrauensliste von Claude Code |
| Renderer (ca. 63 Dateien) | Texte, Icons, Einstellungsbereich „Claude Code“ |

## Vorschlag zur Umsetzung

Zuerst ein Feld `provider: 'claude' | 'codex'` an Account, Session und Terminal (`src/shared/types.ts`) und eine Schnittstelle pro Anbieter, hinter die die Claude-Stellen oben wandern:

- **CLI:** Programm finden, Startargumente für neu / fortsetzen / abzweigen / Login, Umgebung (`CLAUDE_CONFIG_DIR` bzw. `CODEX_HOME`)
- **Sessions:** Pfade, Dateien finden, Transcript parsen (Titel, Prompts, Tokens, Modell, `cwd`)
- **Aktivität:** Beschäftigt / wartet / fertig (Titel bei Claude, Hooks bei Codex)
- **Usage:** Limits und Tokens (API bei Claude, `token_count` bzw. App-Server bei Codex)
- **Erweiterungen:** MCP und App-Kontext pro Session

Danach Codex als zweite Umsetzung dieser Schnittstelle.

### Stufen und Aufwand (grob)

1. **Minimal, ca. 1–2 Tage:** Codex als eigener Tab-Typ, Accounts über `CODEX_HOME`, Login über `codex login`. Keine Sessionübersicht, keine Limits, keine Benachrichtigungen.
2. **Sinnvoll, ca. 1–2 Wochen:** Anbieter-Schnittstelle, Codex-Sessions in Übersicht und Suche, Fortsetzen und Abzweigen, Limits und Tokens aus `token_count`, Beschäftigt/wartet über Hooks.
3. **Vollständig, ca. 3–4 Wochen:** Browser-MCP und App-Kontext für Codex, Limits über den App-Server auch ohne laufende Session, Account-Wechsel am Limit zwischen Codex-Accounts, Einstellungsbereich für Codex.

## Risiken

- **Undokumentiertes Sessionformat:** Kann sich mit jeder Codex-Version ändern, der Parser muss mitgepflegt werden. Tolerant parsen, unbekannte Typen überspringen.
- **Keine Session-ID beim Start:** Die App muss nach dem Start die neue Rollout-Datei finden (neuester Eintrag mit passendem `cwd` und Startzeit) oder die ID aus dem `SessionStart`-Hook nehmen.
- **Login im Schlüsselbund:** Speichert Codex den Login im Windows-Schlüsselbund, trennt `CODEX_HOME` die Accounts eventuell nicht. Pro Account `cli_auth_credentials_store = "file"` erzwingen.
- **Hook-Trust:** Von der App eingetragene Hooks muss der Nutzer einmal bestätigen, oder die App startet mit `--dangerously-bypass-hook-trust` (nur für eigene Hooks vertretbar).
- **Name der App:** „Claude Manager“ passt dann nicht mehr ganz.

## Offene Fragen für einen ersten Test

Codex installieren (`npm i -g @openai/codex`), dann prüfen:

1. Gibt es eine Option, die Session-ID beim Start festzulegen? Sonst: Liefert der `SessionStart`-Hook die ID zuverlässig?
2. Setzt Codex einen Fenstertitel (OSC 0/2), an dem man „beschäftigt“ erkennt?
3. Funktioniert MCP pro Start über `-c 'mcp_servers.x.command="…"'` ohne `config.toml` zu ändern?
4. Welches Format und welche Ereignisse liefert `notify`?
5. Laufen zwei `CODEX_HOME` mit verschiedenen Logins gleichzeitig, und wo landet der Login standardmäßig?
6. Wie sehen aktuelle Rollout-Dateien aus (gegenüber 0.61)? Gibt es inzwischen ein Ereignis für „Antwort fertig“?
7. Gibt es eine Option für einen zusätzlichen Systemprompt (für den App-Kontext)?
