import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions } from '@shared/version'
import type { ClaudeCli } from './claude-cli'
import type { SettingsService } from './settings-service'
import type { SessionArgsProvider } from './terminal-service'
import type { WorkspacePrompt, WorkspaceService } from './workspace-service'

/**
 * What every session the app starts learns about the app, appended to Claude Code's system prompt:
 * the user never sees it, and it asks for no answer. It lets Claude understand what the user means
 * by "the tab", "the browser next to it" or a page of the settings. Claude Code sends it with every
 * request (about 400 tokens, mostly read from the prompt cache): kept as short as it goes, and
 * the setting `appContext` leaves it out.
 */
export const APP_CONTEXT_PROMPT = `You run inside Claude Manager, a desktop app with Claude Code sessions, shells and browsers as tabs; "the app", "the tab" etc. mean it. Its UI is German. Say so when asked what or where you are or what you can do; don't bring it up otherwise.
- Tabs in Titelleiste or Seitenleiste; rename: double-click or Kontextmenü; Infokarte; dot = news, orange = waits for user.
- Geteilter Tab: terminals side by side or stacked (session, shell or browser). In groups (like VS Code) one Browser tab shows the pages of the session with the keyboard.
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
 * Whether a session can get a prompt file, given the user's own arguments (`extra`) and the version of
 * Claude Code (`null` while unknown). Not when it would clash with them: a file of the user's own wins
 * anyway (of an option given twice, the last counts), and older versions don't take the user's
 * `--append-system-prompt` together with a file.
 */
export function promptFileAllowed(extra: readonly string[], version: string | null): boolean {
  if (extra.some((arg) => APPEND_PROMPT_FILE_RE.test(arg))) return false
  if (version && compareVersions(version, FILE_MIN_VERSION) < 0) return false
  const ownPrompt = extra.some((arg) => APPEND_PROMPT_RE.test(arg))
  return !ownPrompt || (!!version && compareVersions(version, COMBINED_MIN_VERSION) >= 0)
}

/** The option that hands a session the prompt file; nothing when it isn't allowed (see `promptFileAllowed`). */
export function appContextArgs(file: string, extra: readonly string[], version: string | null): string[] {
  // `=` form: an option of the user's that takes several values would otherwise take the path as one more.
  return promptFileAllowed(extra, version) ? [`--append-system-prompt-file=${file}`] : []
}

/** What a session learns from the workspaces it lies in, the outermost first. */
export function workspacePromptText(prompts: readonly WorkspacePrompt[]): string {
  return prompts
    .map(
      (p) =>
        `The user set these instructions for every project in the workspace "${p.name}" (${p.path}). Follow them in this session:\n\n${p.text}\n`,
    )
    .join('\n')
}

/**
 * Appends to the system prompt of every session the app starts (as one file: Claude Code takes only
 * the last `--append-system-prompt-file`): the app's context (see APP_CONTEXT_PROMPT, unless the
 * setting `appContext` says no) and the prompts of the workspaces the session's folder lies in.
 */
export class SessionPrompt implements SessionArgsProvider {
  private readonly appFile: string
  /** Files of the app's context together with workspace prompts, named after their content. */
  private readonly combinedDir: string
  private appWritten = false
  private combinedCleared = false

  constructor(
    userDataDir: string,
    private readonly cli: ClaudeCli,
    private readonly settings: SettingsService,
    private readonly workspaces: Pick<WorkspaceService, 'promptsFor'>,
  ) {
    this.appFile = join(userDataDir, 'claude-context.md')
    this.combinedDir = join(userDataDir, 'session-prompts')
  }

  args(_terminalId: string, extra: readonly string[], cwd?: string): string[] {
    const appContext = this.settings.get().claude.appContext
    const workspace = cwd ? workspacePromptText(this.workspaces.promptsFor(cwd)) : ''
    if (!appContext && !workspace) return []
    if (!promptFileAllowed(extra, this.cli.knownVersion())) return []
    const file = workspace
      ? this.combinedFile(appContext ? `${APP_CONTEXT_PROMPT}\n${workspace}` : workspace)
      : this.ensureAppFile()
    return file ? [`--append-system-prompt-file=${file}`] : []
  }

  release(): void {
    // The files are shared by the sessions; they stay.
  }

  /**
   * Written with the first session of a run (an update may bring a new text) and again whenever it
   * has gone missing: without the file Claude Code would not start.
   */
  private ensureAppFile(): string | null {
    if (this.appWritten && existsSync(this.appFile)) return this.appFile
    try {
      writeFileSync(this.appFile, APP_CONTEXT_PROMPT)
      this.appWritten = true
      return this.appFile
    } catch (error) {
      console.error('[session-prompt] prompt file could not be written', error)
      return null
    }
  }

  /**
   * One file per text, shared by the sessions with the same one. The first one of a run clears out
   * those of earlier runs: their sessions ended with the app.
   */
  private combinedFile(text: string): string | null {
    const file = join(this.combinedDir, `${createHash('sha256').update(text).digest('hex').slice(0, 16)}.md`)
    try {
      if (!this.combinedCleared) {
        rmSync(this.combinedDir, { recursive: true, force: true })
        this.combinedCleared = true
      }
      if (!existsSync(file)) {
        mkdirSync(this.combinedDir, { recursive: true })
        writeFileSync(file, text)
      }
      return file
    } catch (error) {
      console.error('[session-prompt] prompt file could not be written', error)
      return null
    }
  }
}
