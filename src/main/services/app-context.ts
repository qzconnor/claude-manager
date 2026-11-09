import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions } from '@shared/version'
import type { ClaudeCli } from './claude-cli'
import type { SettingsService } from './settings-service'
import type { SessionArgsProvider } from './terminal-service'

/**
 * What every session the app starts learns about the app, appended to Claude Code's system prompt:
 * the user never sees it, and it asks for no answer. It lets Claude understand what the user means
 * by "the tab", "the browser next to it" or a page of the settings. Claude Code sends it with every
 * request (about 400 tokens, mostly read from the prompt cache): kept as short as it goes, and
 * the setting `appContext` leaves it out.
 */
export const APP_CONTEXT_PROMPT = `You run inside Claude Manager, a desktop app with Claude Code sessions, shells and browsers as tabs; "the app", "the tab" etc. mean it. Its UI is German. Say so when asked what or where you are or what you can do; don't bring it up otherwise.
- Tabs in Titelleiste or Seitenleiste; rename: double-click or Kontextmenü; Infokarte; dot = news, orange = waits for user.
- Geteilter Tab: terminals side by side or stacked (session, shell or browser).
- Dateibaum (Ctrl+Shift+E): the tab's folder with git status beside the terminal; files Claude reads, searches, writes (also by shell commands) or commits light up; a click on a file shows its changes since the last commit, live (split beside the terminal, or a tab in groups).
- Several accounts; at a limit a session continues with another (Account wechseln).
- Left rail: Sessions (search, resume, fork, delete), Usage-Dashboard, Accounts, Einstellungen: Darstellung, Terminal, Claude Code, Werkzeuge, Benachrichtigungen, API, Updates, Info.
- Befehlspalette (Ctrl+Shift+P), notifications, \`cm\` command, local REST API.
You act in the app only via enabled claude-manager MCP tools (Einstellungen > Werkzeuge, incl. Ohne Nachfrage); changes apply to new sessions. Else tell the user where to click.
`

/** Claude Code documents `--append-system-prompt-file` for interactive sessions since this version. */
const FILE_MIN_VERSION = '2.1.69'
/** Since this version Claude Code takes `--append-system-prompt` and its file form together; older ones only one of them. */
const COMBINED_MIN_VERSION = '2.1.283'

const APPEND_PROMPT_RE = /^--append-system-prompt(=|$)/
const APPEND_PROMPT_FILE_RE = /^--append-system-prompt-file(=|$)/

/**
 * The option that hands a session the prompt file, given the user's own arguments (`extra`) and the
 * version of Claude Code (`null` while unknown). Nothing when it would clash with them: a file of the
 * user's own wins anyway (of an option given twice, the last counts), and older versions don't take
 * the user's `--append-system-prompt` together with a file.
 */
export function appContextArgs(file: string, extra: readonly string[], version: string | null): string[] {
  if (extra.some((arg) => APPEND_PROMPT_FILE_RE.test(arg))) return []
  if (version && compareVersions(version, FILE_MIN_VERSION) < 0) return []
  const ownPrompt = extra.some((arg) => APPEND_PROMPT_RE.test(arg))
  if (ownPrompt && (!version || compareVersions(version, COMBINED_MIN_VERSION) < 0)) return []
  // `=` form: an option of the user's that takes several values would otherwise take the path as one more.
  return [`--append-system-prompt-file=${file}`]
}

/** Gives every session the app's context (see APP_CONTEXT_PROMPT) as a file in the app's data folder, unless the settings say no. */
export class AppContextPrompt implements SessionArgsProvider {
  private readonly file: string
  private written = false

  constructor(
    userDataDir: string,
    private readonly cli: ClaudeCli,
    private readonly settings: SettingsService,
  ) {
    this.file = join(userDataDir, 'claude-context.md')
  }

  args(_terminalId: string, extra: readonly string[]): string[] {
    if (!this.settings.get().claude.appContext) return []
    const args = appContextArgs(this.file, extra, this.cli.knownVersion())
    return args.length && this.ensureFile() ? args : []
  }

  release(): void {
    // One file for all sessions; it stays.
  }

  /**
   * Written with the first session of a run (an update may bring a new text) and again whenever it
   * has gone missing: without the file Claude Code would not start.
   */
  private ensureFile(): boolean {
    if (this.written && existsSync(this.file)) return true
    try {
      writeFileSync(this.file, APP_CONTEXT_PROMPT)
      this.written = true
      return true
    } catch (error) {
      console.error('[app-context] prompt file could not be written', error)
      return false
    }
  }
}
