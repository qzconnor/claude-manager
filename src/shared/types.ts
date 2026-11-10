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

/** `row`: the parts lie side by side (split vertically), `column`: one above the other (split horizontally). */
export type SplitDirection = 'row' | 'column'

/** Two parts of a tab: `first` left of `second` (`row`) or above it (`column`). */
export interface PaneSplit {
  direction: SplitDirection
  /** `first`'s share of the space. */
  ratio: number
  first: PaneNode
  second: PaneNode
}

/** How the terminals of a tab share its space: a terminal id, or a split into two parts. */
export type PaneNode = string | PaneSplit

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
  /** Opens in the tab of `terminalId`, next to it: to the right (`row`) or below (`column`). */
  split?: { terminalId: string; direction: SplitDirection } | null
  /** Takes the place of this terminal, in the tab order and in its tab; the old one stays open until it is closed. */
  replaces?: string | null
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

/** How full a session's context is: from its transcript, and where it compacts from Claude Code's settings. */
export interface SessionContext {
  /** Tokens in the context after the latest answer; after a compaction its summary. Null before the first answer. */
  tokens: number | null
  /** Where Claude Code compacts by itself (the window less room for answer and summary); null when auto-compact is off. */
  compactAt: number | null
  /** The auto-compact window: set with `/autocompact`, otherwise the model's context window. */
  window: number
  /** The window was set with `/autocompact` (or the setting), not the model's own. */
  configured: boolean
  /** e.g. `claude-opus-5-5`; null when the transcript doesn't tell. */
  model: string | null
}

/**
 * What runs in a part of a tab: a Claude Code session, a login, a shell, or (`browser`) a web page
 * without a process, whose `url` is set instead.
 */
export type TerminalMode = 'session' | 'login' | 'shell' | 'browser'

/** A browser in a new tab or next to a terminal (see `TerminalInfo.url`). */
export interface BrowserOpenOptions {
  /** http(s); the empty page when missing. */
  url?: string | null
  title?: string | null
  /** Opens in the tab of `terminalId`, next to it: to the right (`row`) or below (`column`). */
  split?: { terminalId: string; direction: SplitDirection } | null
}

/** What a browser shows, as its page reports it. */
export interface BrowserPage {
  url: string
  title: string
}

/** Where a download of the browser stands. */
export type BrowserDownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted'

/**
 * A file the browser downloads or downloaded, into the user's downloads folder. All browser tabs
 * share one list, like the windows of Chrome.
 */
export interface BrowserDownload {
  id: string
  /** The page it came from (the id of its contents), so its pane can show it; 0 when unknown. */
  contentsId: number
  /** The name it got in the folder (with a number when the name was taken). */
  filename: string
  path: string
  url: string
  state: BrowserDownloadState
  receivedBytes: number
  /** 0 when the server didn't say. */
  totalBytes: number
  /** ISO time. */
  startedAt: string
}

/** What the user can do with a download in the list. */
export type BrowserDownloadAction = 'open' | 'show' | 'cancel' | 'remove'

/** A site (or a proxy) asks for a user name and password (HTTP authentication) before it shows the page. */
export interface BrowserLoginRequest {
  id: string
  /** The page that asks (the id of its contents); its pane shows the question. */
  contentsId: number
  /** Host, with the port when it is not the scheme's own. */
  host: string
  /** The name the site gives the protected area; may be empty. */
  realm: string
  /** A proxy asks, not the site. */
  proxy: boolean
  /** The password would go over an unencrypted connection (http). */
  insecure: boolean
}

export interface BrowserCredentials {
  username: string
  password: string
}

/** How an action of Claude in a browser went; `warning`: the page reported an error by itself. */
export type BrowserActivityStatus = 'running' | 'done' | 'error' | 'warning'

/** One line of the log next to a browser that Claude drives. */
export interface BrowserActivity {
  /** Counts up per browser; the update of a running action keeps its id. */
  id: number
  /** When it started (ISO). */
  at: string
  /** The tool (`click`, `navigate` …); `console`, `network` and `page-dialog` for what the page did, `control` for the user taking over. */
  kind: string
  /** In words, e.g. „Klickt auf „Anmelden““. */
  label: string
  status: BrowserActivityStatus
  /** The error, or what came out of it. */
  detail: string | null
  durationMs: number | null
  /** A small picture of the page, when Claude took a screenshot (JPEG data URL). */
  image: string | null
}

/** Who drives a browser tab. */
/** The page size a Claude session gave a browser (CSS pixels), instead of the size of its part of the tab. */
export interface BrowserViewport {
  width: number
  height: number
  /** Phone mode: touch, a phone's user agent, the page's viewport meta tag. */
  mobile: boolean
  /** The page's zoom when the size was set: its view is this much larger in the window. */
  zoom: number
}

export interface BrowserControlState {
  /** The terminal of the Claude session that uses the browser. */
  sessionId: string
  sessionTitle: string
  /** An action runs right now. */
  busy: boolean
  /** Claude acted a moment ago: the page keeps its size and is drawn even while its tab is hidden. */
  active: boolean
  /** The user took the browser over; Claude's next action waits until it is handed back. */
  takenOver: boolean
  /** The size Claude gave the page; null: it fills its part of the tab. */
  viewport: BrowserViewport | null
  /** What Claude has the page pretend (dark mode, slow network …); null: nothing. */
  emulation: BrowserEmulation | null
  /** Requests Claude answers, slows down or blocks itself (browser_route); they end with the session. */
  routes: BrowserRoute[]
}

/** A route of Claude's for the page's requests, as the badge over the page shows it. */
export interface BrowserRoute {
  id: number
  /** The addresses it takes: `*` matches anything; without `*` an address that contains it. */
  pattern: string
  /** Only requests with this method (GET, POST …); null: all. */
  method: string | null
  /** fulfill: Claude's answer; fail: a network error; delay: the real answer, later. */
  action: 'fulfill' | 'fail' | 'delay'
  /** The status of Claude's answer (fulfill). */
  status: number | null
  delayMs: number
  /** How many requests it took so far. */
  hits: number
  /** It ends after this many more requests; null: with the session. */
  timesLeft: number | null
}

/** A network as Claude can have the page feel it (Chrome's presets). */
export type BrowserNetworkPreset = 'offline' | 'slow-3g' | 'fast-3g' | 'fast-4g'

/** Permissions Claude can give the page or refuse it (browser_emulate). */
export type BrowserPermission = 'geolocation' | 'notifications' | 'camera' | 'microphone' | 'clipboard-read'

/** Where the page believes it is (browser_emulate). */
export interface BrowserGeolocation {
  latitude: number
  longitude: number
  /** Meters. */
  accuracy: number
}

/** What Claude has the page pretend (browser_emulate); it ends with the session or the user's reset. */
export interface BrowserEmulation {
  /** `prefers-color-scheme`; null: the system's. */
  colorScheme: 'light' | 'dark' | null
  /** `prefers-reduced-motion: reduce`. */
  reducedMotion: boolean
  network: BrowserNetworkPreset | null
  /** The page runs this many times slower (2–20); null: at full speed. */
  cpuSlowdown: number | null
  /** Language and formats, e.g. `de-DE`; null: the app's. */
  locale: string | null
  /** IANA time zone, e.g. `America/New_York`; null: the computer's. */
  timezone: string | null
  /** Where the page believes it is; it also gets the permission for the location. null: nowhere. */
  geolocation: BrowserGeolocation | null
  /** Permissions the page gets or is refused; those left out the browser refuses as always. */
  permissions: Partial<Record<BrowserPermission, 'granted' | 'denied'>>
}

/** Where Claude acts in the page, for the highlight over it; in pixels of the view. */
export interface BrowserHighlight {
  label: string
  rect: { x: number; y: number; width: number; height: number } | null
  /** Where Claude's mouse pointer goes, gliding from its last spot; null: it stays where it is. */
  point: { x: number; y: number } | null
  /** The pointer clicks once it is at `point`. */
  click: boolean
  /** How long the pointer takes to get to `point` (ms); main acts once it is there. */
  moveMs: number
}

/** An image pasted into a session (`[Image #N]`). */
export interface PastedImage {
  /** data URL */
  src: string
  /** Sent with a prompt; otherwise the app's copy from the clipboard, taken when it was pasted. */
  sent: boolean
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
  /** How full the session's context is, from its start (tokens from the first answer on); null for shells, logins and browsers. */
  context: SessionContext | null
  /** Claude Code works on a turn, as its window title shows (also when started in a shell tab). */
  busy: boolean
  /** Something happened in the tab while it wasn't shown; cleared once it is (setting `notifications.unreadDot`). */
  attention: AttentionKind | null
  /** No notifications and no flashing taskbar for this tab; the unread dot stays. */
  muted: boolean
  /** What the tab shows: the name it was given (`fixedTitle`), otherwise `autoTitle`. */
  title: string
  /** The title was given (renamed, or passed when opening) and doesn't follow the session. */
  fixedTitle: boolean
  /**
   * The title the tab has without a name of its own, also while it has one: the session's as in
   * `/resume` (the one Claude gave it), a browser's page title, otherwise a default.
   */
  autoTitle: string
  /** The folder the session works in: where it started, or where `/cd` moved it. Empty for a browser, as are the account ids. */
  cwd: string
  mode: TerminalMode
  /** The page a browser shows; null for terminals. */
  url: string | null
  resumeSessionId: string | null
  status: TerminalStatus
  exitCode: number | null
  pid: number
  createdAt: string
  /** Command line that was started (for display / debugging, secrets are never included). */
  commandLine: string
  /**
   * The session works in a git worktree Claude Code made for it (`--worktree`); `cwd` stays the
   * folder it was started in. Null for shells, browsers and sessions without one.
   */
  worktree: SessionWorktree | null
  /**
   * Claude Code tells the app its state through hooks (setting `claude.hookState`): the end of a turn
   * and waits for the user right away, and what runs. Otherwise the app reads it from the window title
   * and the transcript, and `activity`, `subagents` and `compacting` stay empty.
   */
  hooks: boolean
  /** The tool Claude runs in the session's own turn. Only counts while `busy`: a declined permission leaves it. */
  activity: TerminalActivity | null
  /** Subagents that run for the session. */
  subagents: number
  /** Claude Code compacts the conversation (`/compact` or by itself). */
  compacting: boolean
}

/** A tool Claude runs in a session, as Claude Code's hooks tell it (see `TerminalInfo.hooks`). */
export interface TerminalActivity {
  /** e.g. `Bash`, `Edit`, `mcp__claude-manager__browser_click` */
  tool: string
  /** What it runs on: the command, the file, the search … */
  detail: string | null
  since: string
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

/** A git worktree Claude Code made for a session (`claude --worktree`), as its transcript records it. */
export interface SessionWorktree {
  name: string
  /** The worktree's branch, e.g. `worktree-<name>`. */
  branch: string | null
  /** The worktree's folder, usually `<repository>/.claude/worktrees/<name>`; gone once it was removed. */
  path: string
  /** The folder the session was started in: the checkout the worktree belongs to. */
  originalCwd: string
}

export interface SessionSummary {
  id: string
  accountId: string
  /** Encoded project folder name under `<configDir>/projects`. */
  projectKey: string
  /** Where the session ran, or where `/cd` moved it last; for a session in a worktree, the worktree's folder. */
  cwd: string | null
  /** The latest worktree the session worked in; it belongs with `worktree.originalCwd`. */
  worktree: SessionWorktree | null
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
  /** Where the window heads at the current pace; null or missing while that can't be told yet. */
  forecast?: UsageForecast | null
}

/** Where a usage window heads at the current pace (see `src/shared/usage-forecast.ts`). */
export interface UsageForecast {
  /** When the window reaches 100 % at this pace; null when it lasts until the reset. */
  exhaustsAt: string | null
  /** The usage expected at the reset at this pace, in percent; can be over 100. */
  atReset: number
  /** Percentage points per hour. */
  ratePerHour: number
  /** The pace of the last while (`recent`), or the average since the window began (`window`). */
  basis: 'recent' | 'window'
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

/** The usage of the sessions that ran in one folder; worktree sessions count for the folder they were started in. */
export interface FolderTokenStats extends TokenCounts {
  /** Null when no session of the folder records it. */
  path: string | null
  /** Claude Code's project folder name, for folders without a path. */
  projectKey: string
  sessionCount: number
}

export interface AccountTokenStats {
  accountId: string
  days: DailyTokenStats[]
  models: ModelTokenStats[]
  /** Largest first (by `weightedTokens`). */
  folders: FolderTokenStats[]
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
/** Claude Code's crab (the logo, also while it moves): in the theme's accent or Claude's own orange. */
export type LogoColor = 'theme' | 'original'

/**
 * Where the terminal tabs are: in the title bar or listed in the nav sidebar, or (`groups`) like VS Code's
 * editor groups: every part of the window has its own tab bar, the pages open as tabs too.
 */
export type TabPosition = 'top' | 'sidebar' | 'groups'

/** The side of a tab's area where its file tree opens; its button sits on the same side of the tab bar. */
export type FileTreeSide = 'left' | 'right'

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
  fileTreeSide: FileTreeSide
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
  logoColor: LogoColor
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
  /** Sessions the app starts get its browser as a tool (an MCP server of the app, `--mcp-config`). */
  browserTools: boolean
  /** Claude Code uses the browser without asking before every action (`--allowedTools`). */
  browserToolsAllowed: boolean
  /**
   * Sessions the app starts with its browser run without Claude in Chrome (`--no-chrome`), so Claude
   * takes the app's browser instead of the user's Chrome. Claude Code's own setting stays as it is.
   */
  noClaudeInChrome: boolean
  /** The hint in sessions that start with Claude in Chrome was put away for good. */
  claudeInChromeHintDismissed: boolean
  /**
   * Sessions the app starts know that they run in it: a short description of the app is appended to
   * Claude Code's system prompt (`--append-system-prompt-file`). Off saves its tokens.
   */
  appContext: boolean
  /**
   * Sessions the app starts tell it their state through Claude Code's hooks (`--settings`, HTTP hooks
   * to the app): the end of a turn and waits for the user right away, the tool that runs, subagents.
   */
  hookState: boolean
  /** Sessions the app starts can read the limits of the account they run on (tool `limits`). */
  limitsTool: boolean
  /** Sessions the app starts can search and read the transcripts of earlier sessions (`sessions_search`, `session_read`). */
  sessionsTool: boolean
  /**
   * Sessions the app starts can create, change and switch the app's color themes when the user asks
   * for it (`themes_list`, `theme_create`, `theme_update`, `theme_apply`). Claude Code asks before
   * each change, whatever the settings allow.
   */
  themesTool: boolean
  /**
   * Sessions the app starts can open shell tabs next to themselves, run commands in them and read
   * their output (`shell_*`). The commands run outside Claude Code's permissions.
   */
  shellTools: boolean
  /** Claude Code uses the shell tools without asking every time (`--allowedTools`). */
  shellToolsAllowed: boolean
}

/** Where Claude Code connects Claude in Chrome when a session starts (unless it gets `--no-chrome`). */
export interface ClaudeInChromeStatus {
  /** The accounts whose Claude Code has "Enabled by default" on. */
  accounts: { id: string; name: string }[]
  /** CLAUDE_CODE_ENABLE_CFC turns it on for every session the app starts. */
  env: boolean
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
// Workspaces
// ---------------------------------------------------------------------------

/**
 * A folder whose subfolders are projects that share a system prompt: what its `cm_prompts.md` says
 * is appended to the system prompt of every session the app starts in it.
 */
export interface Workspace {
  path: string
  /** The folder's name. */
  name: string
  /** False while the folder can't be found, e.g. on a drive that isn't there. */
  exists: boolean
  /** Names of the subfolders, without hidden ones (`.git`) and nested workspaces, sorted. */
  projects: string[]
  /** `cm_prompts.md` has some text. */
  hasPrompt: boolean
}

/** A folder the app moved (`workspaces.move`). */
export interface FolderMoveResult {
  /** Where it is now. */
  path: string
  /** Sessions that went along. */
  sessions: number
  /** Moved to another drive: copied, but not all of the old folder could be deleted. */
  leftover: boolean
}

/** A folder of a workspace moved outside the app. */
export interface FolderMovedEvent {
  from: string
  to: string
  /** Sessions that went along. */
  sessions: number
}

export interface WorkspaceCreateInput {
  /** The folder the workspace's folder is made in. */
  parent: string
  name: string
  /** Text for `cm_prompts.md`; empty leaves it empty. */
  prompt: string
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

/** Whether a session in `cwd` can get a worktree of its own (`claude --worktree`). */
export type WorktreeCheck =
  | {
      ok: true
      /** The repository's top folder; the worktrees lie in its `.claude\worktrees`. */
      root: string
      /** Names of the worktrees Claude Code made there before; one of them is entered again. */
      existing: string[]
    }
  | { ok: false; reason: string }

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

/** An entry of a folder in the file tree. */
export interface FileEntry {
  name: string
  /** A folder, also behind a link. */
  dir: boolean
  /** A symbolic link or junction. */
  link: boolean
  /** A link whose target is missing. */
  broken: boolean
}

/** A folder's entries, folders first, each part sorted by name like the Explorer does. */
export interface FileListing {
  entries: FileEntry[]
  /** Entries left out because the folder has too many. */
  omitted: number
}

/** The files of a tree's folder, for the search across folders that are not open. */
export interface FileSearchList {
  /** Paths relative to the folder, `/`-separated. In a repository without the ones git ignores. */
  paths: string[]
  /** More files than were listed. */
  truncated: boolean
}

/** How git sees a file of the tree. */
export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict'

export interface GitFileState {
  status: GitFileStatus
  /** The change is staged, at least partly. */
  staged: boolean
  /** Lines added and removed since the last commit; null for binary and untracked files and before the first commit. */
  added: number | null
  removed: number | null
}

/** Git's view of a tree's folder: the branch and the changed and ignored files in it. */
export interface GitTreeStatus {
  /** The checked-out branch; null with a detached HEAD. */
  branch: string | null
  /** Short hash of HEAD; null before the first commit. */
  commit: string | null
  /** The branch the checked-out one follows, e.g. `origin/main`. */
  upstream: string | null
  /** Commits ahead of and behind the upstream. */
  ahead: number
  behind: number
  /** Changed files by their path relative to the tree's folder (`/`-separated); untracked folders end with `/`. */
  files: Record<string, GitFileState>
  /** Ignored files and folders (ending with `/`), relative to the tree's folder. */
  ignored: string[]
  /** More changes or ignored paths than were sent. */
  truncated: boolean
}

/** A file's changes since the last commit, or the file itself when there are none to show. */
export interface FileDiff {
  /** `git diff HEAD` of the file, staged and unstaged changes together; '' without changes or outside a repository. */
  patch: string
  /** The file as it is when there is no patch: unchanged, not yet known to git, or outside a repository. */
  text: string | null
  /** The folder is a git repository with a commit to compare with. */
  repo: boolean
  binary: boolean
  /** Too big to show. */
  tooLarge: boolean
  /** The file isn't there (deleted, or not yet written). */
  missing: boolean
}

/** What Claude does with a file: reads it, searches it (or a search found it), writes it, or commits it. */
export type FileTouchKind = 'read' | 'search' | 'write' | 'commit'

/** A file Claude touched, by its absolute path. */
export interface FileTouch {
  path: string
  kind: FileTouchKind
}

/** A tree whose folders the main process watches: its folder, and (Linux) the open subfolders. */
export interface FileTreeWatch {
  root: string
  /** Open folders relative to `root` (`/`-separated); on Windows and macOS the whole folder is watched anyway. */
  dirs: string[]
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
