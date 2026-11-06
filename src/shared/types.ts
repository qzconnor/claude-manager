/**
 * Types shared between the main process, the preload bridge and the renderer.
 * Everything in here must be structured-clone safe (plain data only).
 */

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * How an account authenticates Claude Code.
 * - `system`: the default `~/.claude` login of this machine (no CLAUDE_CONFIG_DIR override)
 * - `oauth`:  an isolated config dir that is logged in via `claude auth login`
 * - `token`:  a long-lived token from `claude setup-token`, passed as CLAUDE_CODE_OAUTH_TOKEN
 * - `apiKey`: an Anthropic API key, passed as ANTHROPIC_API_KEY
 */
export type AccountKind = 'system' | 'oauth' | 'token' | 'apiKey'

/**
 * Who is logged in. For browser logins Anthropic is asked which account and organization the
 * current token belongs to; until it answered, Claude Code's config is used if it fits the plan.
 */
export interface AccountIdentity {
  email: string | null
  displayName: string | null
  organizationUuid: string | null
  /** Personal organizations are called "<email>'s Organization". */
  organizationName: string | null
  /** e.g. `claude_pro`, `claude_max`, `claude_team`, `claude_enterprise` */
  organizationType: string | null
  /** e.g. `pro`, `max`, `team` (from the stored OAuth credentials) */
  subscriptionType: string | null
  rateLimitTier: string | null
}

/**
 * The login an account is meant for, e.g. taken over from claude-swap (cswap). Shown until the
 * account is logged in; a login of another person or organization is pointed out.
 */
export interface ExpectedLogin {
  email: string
  accountUuid: string | null
  organizationUuid: string | null
  /** Personal organizations are called "<email>'s Organization". */
  organizationName: string | null
}

export type AuthState =
  /** credentials present and the access token is not expired */
  | 'ok'
  /** OAuth credentials present, but the access token expired (Claude Code refreshes it on next start) */
  | 'expired'
  /** no usable credentials found */
  | 'missing'

export interface Account {
  id: string
  name: string
  kind: AccountKind
  /** Accent color used for badges, tabs and grouping (hex, e.g. `#d97757`). */
  color: string
  /** Effective Claude config dir (CLAUDE_CONFIG_DIR) — `~/.claude` for the system account. */
  configDir: string
  /** Whether the config dir was chosen by the user instead of being app-managed. */
  customConfigDir: boolean
  /** Default working directory for new terminals of this account. */
  defaultCwd: string | null
  /** Extra CLI arguments appended to every `claude` launch of this account. */
  extraArgs: string[]
  createdAt: string
  /** A token / API key is stored (encrypted) for this account. */
  hasSecret: boolean
  /** Masked preview of the stored secret, e.g. `sk-ant-oat01-…a1b2`. */
  secretHint: string | null
  authState: AuthState
  identity: AccountIdentity
  /** ISO timestamp the access token expires (OAuth/system accounts only). */
  tokenExpiresAt: string | null
  /** Who should log in here, e.g. after an import from cswap; `null` when nobody in particular. */
  expectedLogin: ExpectedLogin | null
}

export interface AccountCreateInput {
  name: string
  kind: Exclude<AccountKind, 'system'>
  color: string
  /** Token or API key for `token` / `apiKey` accounts. */
  secret?: string
  /** Use an existing directory as CLAUDE_CONFIG_DIR instead of an app-managed one. */
  configDir?: string | null
  defaultCwd?: string | null
  extraArgs?: string[]
  /** Copy settings.json, CLAUDE.md, skills, commands, agents… from ~/.claude into the new profile. */
  importSettings?: boolean
}

export interface AccountUpdateInput {
  name?: string
  color?: string
  /** `null` clears nothing — pass a new value to replace the stored secret. */
  secret?: string
  defaultCwd?: string | null
  extraArgs?: string[]
  /** `null` forgets the expected login; the account keeps the login it has. */
  expectedLogin?: null
}

// ---------------------------------------------------------------------------
// claude-swap (cswap)
// ---------------------------------------------------------------------------

/** An account claude-swap knows. Only its metadata: cswap's stored credentials are never read. */
export interface CswapAccount {
  /** cswap's number for the account, e.g. for `cswap --switch-to 2` */
  number: number
  /** Name the app account gets: cswap's alias, otherwise the email (plus the organization if needed). */
  name: string
  alias: string | null
  email: string
  accountUuid: string | null
  organizationUuid: string | null
  /** Personal organizations are called "<email>'s Organization". */
  organizationName: string | null
  /** cswap has currently switched ~/.claude, the standard account, to this login. */
  active: boolean
  /** App account that is already meant for or logged in as this login. */
  existingAccountId: string | null
}

export interface CswapStatus {
  /** cswap is installed and knows at least one account. */
  available: boolean
  accounts: CswapAccount[]
}

export interface CswapImportInput {
  /** cswap numbers of the accounts to create */
  numbers: number[]
  /** Copy settings.json, CLAUDE.md, skills… from ~/.claude into the new profiles. */
  importSettings: boolean
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

export type TerminalStatus = 'running' | 'exited'

export interface TerminalCreateOptions {
  /** Account whose config dir holds the session (transcripts, settings). */
  accountId: string
  /**
   * Account whose token or API key the session runs with (limits, billing); defaults to `accountId`.
   * Must be a token or API key account: a browser login only works in its own config dir.
   */
  authAccountId?: string | null
  /** Working directory; defaults to the account's default or the app default. */
  cwd?: string | null
  /** Resume an existing Claude Code session (`--resume <id>`). */
  resumeSessionId?: string | null
  /** Together with `resumeSessionId`: branch into a new session id (`--fork-session`). */
  forkSession?: boolean
  /** Additional CLI args for this launch only. */
  args?: string[]
  /** A message Claude Code sends right after starting, e.g. to carry on after an account switch. */
  prompt?: string | null
  /** Run a special command instead of the interactive session. */
  mode?: 'session' | 'login' | 'shell'
  title?: string | null
  /** Start without notifications for this tab (see `TerminalInfo.muted`). */
  muted?: boolean
  cols?: number
  rows?: number
}

/**
 * Why a tab wants attention after Claude Code ended its turn.
 * - `done`:  the answer is finished
 * - `input`: Claude Code waits for the user: a permission, the answer to a question or the approval of a plan
 * - `limit`: the session stopped at a usage limit
 */
export type AttentionKind = 'done' | 'input' | 'limit'

/** A Claude Code session whose last answer was a usage limit. */
export interface SessionLimit {
  /** e.g. `five_hour`, `seven_day`; null when Claude Code didn't say. */
  type: string | null
  resetsAt: string | null
  /** Claude Code's own message, e.g. "You've hit your session limit · resets 7:40pm". */
  message: string
}

export interface TerminalInfo {
  id: string
  /** Account whose config dir holds the session. */
  accountId: string
  /** Account whose login, token or API key the process uses; differs after switching accounts. */
  authAccountId: string
  /** Claude Code session currently open in the tab; null until known (or for shells). */
  sessionId: string | null
  /** Set while the session is stopped by a usage limit. */
  limit: SessionLimit | null
  /** Claude Code works on a turn, as its window title shows (also when started in a shell tab). */
  busy: boolean
  /** Something happened in the tab while it wasn't shown; cleared once it is (setting `notifications.unreadDot`). */
  attention: AttentionKind | null
  /** No notifications and no flashing taskbar for this tab; the unread dot stays. */
  muted: boolean
  /** The session's title as in `/resume`, unless `fixedTitle`; without one a default. */
  title: string
  /** The title was given (renamed, or passed when opening) and doesn't follow the session. */
  fixedTitle: boolean
  cwd: string
  mode: 'session' | 'login' | 'shell'
  resumeSessionId: string | null
  status: TerminalStatus
  exitCode: number | null
  pid: number
  createdAt: string
  /** Command line that was started (for display / debugging, secrets are never included). */
  commandLine: string
}

/** A session that hit a limit went on with another account by itself (setting `claude.autoSwitch`). */
export interface AutoSwitchEvent {
  /** The tab as it stopped at the limit. */
  from: TerminalInfo
  /** The tab the session goes on in; null when the switch failed. */
  to: TerminalInfo | null
  targetId: string
  /** Why the switch failed. */
  error: string | null
}

// ---------------------------------------------------------------------------
// Sessions (Claude Code transcripts)
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string
  accountId: string
  /** Encoded project folder name under `<configDir>/projects`. */
  projectKey: string
  cwd: string | null
  title: string
  firstPrompt: string | null
  lastPrompt: string | null
  gitBranch: string | null
  model: string | null
  /** Number of user + assistant messages (approximate for very large transcripts). */
  messageCount: number
  messageCountExact: boolean
  createdAt: string
  updatedAt: string
  sizeBytes: number
  version: string | null
}

export interface SessionGroup {
  accountId: string
  sessions: SessionSummary[]
  error: string | null
}

/** A session in an account's config dir. */
export interface SessionRef {
  accountId: string
  sessionId: string
}

/** Outcome of moving sessions to the recycle bin. */
export interface SessionRemoveResult {
  removed: SessionRef[]
  /** Size of the removed transcripts. */
  removedBytes: number
  /** Open in a tab or in a running Claude Code: these stay. */
  inUse: SessionRef[]
  /** Could not be moved (e.g. the file is locked). */
  failed: SessionRef[]
  /** Why the first of `failed` could not be moved. */
  error: string | null
}

/** A session whose conversation contains every word of a search. */
export interface SessionSearchHit {
  accountId: string
  sessionId: string
  /** Who wrote the message the snippet is taken from. */
  role: 'user' | 'assistant'
  /** Part of that message around the first match, on one line. */
  snippet: string
  /** How often the longest search word occurs in the conversation. */
  matches: number
}

export interface TranscriptToolCall {
  /** `tool_use` id: loads the complete call with `sessions.toolCall`. */
  id: string | null
  name: string
  summary: string
  /** Outcome of the matching tool result; null when none was recorded (yet). */
  status: 'ok' | 'error' | null
}

/** A tool call with its complete input and output. */
export interface TranscriptToolDetail {
  id: string
  name: string
  /** Input parameters in their original order; non-string values as formatted JSON. */
  input: { key: string; value: string }[]
  /** What the tool returned to Claude; null when no result was recorded. */
  output: string | null
  isError: boolean
  /** A value was longer than the display limit and was cut. */
  truncated: boolean
}

export interface TranscriptMessage {
  uuid: string
  role: 'user' | 'assistant' | 'system'
  timestamp: string | null
  text: string
  tools: TranscriptToolCall[]
  model: string | null
}

export interface SessionDetail {
  summary: SessionSummary
  messages: TranscriptMessage[]
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface UsageWindow {
  key: string
  label: string
  /** 0–100 */
  percent: number
  resetsAt: string | null
  severity: string | null
}

export interface ExtraUsage {
  enabled: boolean
  usedCredits: number | null
  monthlyLimit: number | null
  percent: number | null
  currency: string | null
}

export type UsageStatus =
  | 'ok'
  /** token type can't query usage (setup tokens are inference-only, API keys have no plan limits) */
  | 'unsupported'
  | 'no-credentials'
  | 'expired'
  | 'unauthorized'
  | 'rate-limited'
  | 'error'

export interface AccountUsage {
  accountId: string
  status: UsageStatus
  /** Where the numbers come from. */
  source: 'live' | 'claude-cache' | 'none'
  fetchedAt: string | null
  message: string | null
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  /** Additional limits, e.g. per-model weekly windows. */
  scoped: UsageWindow[]
  extra: ExtraUsage | null
  breakdown: { key: string; label: string; percent: number }[]
  /** Earliest time the app will hit the live endpoint again. */
  nextRefreshAt: string | null
}

export interface TokenCounts {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
  messages: number
}

export interface DailyTokenStats extends TokenCounts {
  /** YYYY-MM-DD (local time) */
  date: string
}

export interface ModelTokenStats extends TokenCounts {
  model: string
}

export interface AccountTokenStats {
  accountId: string
  days: DailyTokenStats[]
  models: ModelTokenStats[]
  totals: TokenCounts
  sessionCount: number
  computedAt: string
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type WindowMaterial = 'acrylic' | 'mica' | 'tabbed' | 'none'
export type CursorStyle = 'block' | 'bar' | 'underline'
export type TerminalRenderer = 'webgl' | 'dom'
export type UnicodeMode = 'graphemes' | 'unicode11'
/**
 * Background of Claude Code's side panels such as /diff and of the bars behind the user's own
 * messages in the transcript. `theme`: a see-through tint of the terminal theme's text color,
 * `terminal`: the terminal background, `original`: Claude Code's own gray.
 */
export type PanelBackground = 'theme' | 'terminal' | 'original'
/** Green and red behind changed lines in Claude Code's diffs: a see-through tint of the theme or Claude's own. */
export type DiffColors = 'theme' | 'original'

/** Where the terminal tabs are: in the title bar or listed in the nav sidebar. */
export type TabPosition = 'top' | 'sidebar'

export interface AppearanceSettings {
  themeId: string
  material: WindowMaterial
  /** Keep the acrylic/mica effect while the window is not focused. */
  keepMaterialWhenInactive: boolean
  /** 0–100: how strongly the theme background tints the window. 100 = opaque. */
  surfaceOpacity: number
  /** UI font size in px. */
  uiFontSize: number
  /** Corner radius in rem for cards / inputs. */
  radius: number
  /** In the sidebar the nav icons also get their labels. */
  tabPosition: TabPosition
}

/** Inner padding of the terminal per side, in px. */
export interface TerminalPadding {
  top: number
  right: number
  bottom: number
  left: number
}

export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
  fontWeight: number
  fontWeightBold: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
  padding: TerminalPadding
  /** 0–100: opacity of the terminal background on top of the window material. */
  backgroundOpacity: number
  renderer: TerminalRenderer
  unicode: UnicodeMode
  copyOnSelect: boolean
  rightClickPaste: boolean
  /** Use a terminal color scheme different from the app theme (theme id) or `null` to follow the app theme. */
  colorSchemeId: string | null
  minimumContrastRatio: number
  panelBackground: PanelBackground
  diffColors: DiffColors
  /**
   * Windows: new tabs use the ConPTY of Windows Terminal that comes with node-pty instead of the one
   * of Windows. It passes queries such as the background color on to the terminal.
   */
  modernConpty: boolean
}

export interface ClaudeSettings {
  /** Path to the `claude` executable. Empty = auto-detect from PATH. */
  executablePath: string
  /** Default working directory for new terminals. Empty = the Downloads folder (`AppInfo.fallbackCwd`). */
  defaultCwd: string
  /** The question for `defaultCwd` on the first start was answered (or put off). */
  defaultCwdAsked: boolean
  /** Extra args appended to every interactive launch. */
  defaultArgs: string[]
  /** Minutes between automatic live usage refreshes (min. 2). */
  usageRefreshMinutes: number
  /** Sent after switching the account of a session that hit its limit. Empty = send nothing. */
  continuePrompt: string
  /** A session that hits a limit continues by itself with the next free account. */
  autoSwitch: boolean
}

/**
 * Whether a tab closes when its process ends by itself (like Windows Terminal's `closeOnExit`).
 * `graceful`: only without an error (exit code 0), e.g. after Ctrl+C in Claude Code or `exit` in a shell.
 */
export type CloseOnExit = 'graceful' | 'always' | 'never'

export interface GeneralSettings {
  confirmCloseRunning: boolean
  closeOnExit: CloseOnExit
  /** Which account the "+" button uses by default. */
  defaultAccountId: string
  /** Remember the open tabs (folder and session) and open them again on the next start. */
  restoreTerminals: boolean
  /** `cm` shows a running tab in the same folder instead of opening another one (`cm -n` always opens one). */
  cmReuseTab: boolean
  /** Closing the window only hides it; the app keeps running in the notification area (tray). */
  runInTray: boolean
  /** Start with Windows; with `runInTray` without a window, only in the notification area. */
  launchAtLogin: boolean
}

/**
 * When a tab interrupts with a notification (and the flashing taskbar):
 * `background` only while the window is in the background, `hidden` also when another tab or page is shown.
 */
export type NotifyWhen = 'background' | 'hidden'

/** How the app points to a tab in which Claude Code is done or needs the user. */
export interface NotificationSettings {
  /** Main switch: off, the app never points to a tab (no notification, no flashing, no dot). */
  enabled: boolean
  /** Claude Code finished its answer. */
  onDone: boolean
  /** A finished answer only interrupts after Claude worked at least this long (s); shorter ones only get the dot. 0 = always. */
  minBusySeconds: number
  /** Claude Code waits for a permission, the answer to a question or the approval of a plan. */
  onInput: boolean
  /** The session stopped at a usage limit. */
  onLimit: boolean
  /** An account's limit reached `nearLimitPercent`: once per account, window and reset, only as a system notification. */
  onNearLimit: boolean
  /** Usage of a limit window (%) from which `onNearLimit` warns. */
  nearLimitPercent: number
  when: NotifyWhen
  /** System notification (Windows: in the notification center). */
  toast: boolean
  /** The notification shows the beginning of the answer, the command waiting for permission or the question. */
  preview: boolean
  /** The notification plays the system sound. */
  sound: boolean
  /** The taskbar button flashes until the window is in front. */
  flashTaskbar: boolean
  /** A dot on tabs with news you haven't seen yet. */
  unreadDot: boolean
}

export interface ApiSettings {
  enabled: boolean
  port: number
}

export interface AppSettings {
  appearance: AppearanceSettings
  terminal: TerminalSettings
  claude: ClaudeSettings
  general: GeneralSettings
  notifications: NotificationSettings
  api: ApiSettings
}

/** Outcome of importing settings from a file. */
export interface SettingsImportResult {
  settings: AppSettings
  /** Settings of the file left as they were: paths that don't exist on this computer. */
  skipped: string[]
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}

// ---------------------------------------------------------------------------
// App / misc
// ---------------------------------------------------------------------------

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  userDataDir: string
  homeDir: string
  /** Where new sessions start when no folder is set: the Downloads folder. */
  fallbackCwd: string
  claudeExecutable: string | null
  claudeVersion: string | null
  /** Windows build number (e.g. 26100), used to configure xterm for ConPTY. */
  windowsBuild: number | null
  /** How the Linux build is installed; `null` elsewhere and for development builds. */
  linuxPackage: 'appimage' | 'deb' | 'rpm' | null
  /** Installed build (not a development build): only it can start at login. */
  packaged: boolean
}

export interface WindowState {
  maximized: boolean
  focused: boolean
  fullscreen: boolean
}

/** The checked-out branch of a git repository. */
export interface GitBranch {
  /** Branch name, or the short commit hash for a detached HEAD. */
  name: string
  detached: boolean
}

/** An in-app message box. The main process requests these too instead of native dialogs. */
export interface DialogOptions {
  title: string
  description?: string
  /** Shown in a monospace box below the title, e.g. a folder. */
  code?: string
  /** `alert` only has a single button. */
  kind?: 'confirm' | 'alert'
  confirmText?: string
  cancelText?: string
  destructive?: boolean
  /** Shows a warning symbol next to the title. */
  warning?: boolean
}

export interface DialogRequest extends DialogOptions {
  id: string
}

/** The `cm` command line launcher. */
export interface CommandStatus {
  /** Windows: cm.exe is part of the installed app. Linux: an installed app (AppImage, deb or rpm). */
  available: boolean
  /** Windows: on the user PATH and registered for the Explorer address bar. Linux: ~/.local/bin/cm points to the app. */
  registered: boolean
  launcherPath: string | null
  /** Why `cm` may not work yet, e.g. ~/.local/bin missing from the PATH. */
  hint: string | null
}

export interface ApiStatus {
  enabled: boolean
  running: boolean
  port: number
  url: string | null
  token: string
  error: string | null
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/**
 * `unsupported`: a development build, only an installed app can update itself.
 * `error` with `next` set means the download failed, without it the check did.
 */
export type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  /** Installed version. */
  current: string
  /** Version offered by the last check. */
  next: string | null
  /** Download progress in percent. */
  progress: number
  /** End of the last check (epoch ms). */
  checkedAt: number | null
  error: string | null
}

/** A published release with its notes. */
export interface ReleaseNote {
  version: string
  /** Publication date (ISO). */
  date: string
  /** Notes rendered and sanitized by GitHub. */
  html: string
  url: string
  /** Pull requests (or issues) the notes link to, in order – their descriptions are the details. */
  references: number[]
}

/** A pull request (or issue) from the release notes with its description. */
export interface ReleaseReference {
  number: number
  title: string
  /** Description as written on GitHub (markdown), empty without one. */
  body: string
  url: string
}
