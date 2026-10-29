import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readdir, readlink, rm, stat, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ACCOUNT_COLORS, SYSTEM_ACCOUNT_ID } from '@shared/defaults'
import type {
  Account,
  AccountCreateInput,
  AccountIdentity,
  AccountKind,
  AccountUpdateInput,
  AuthState,
  ExpectedLogin,
} from '@shared/types'
import { canLendCredentials, maskSecret } from '@shared/utils'
import { claudePaths, defaultClaudeConfigDir, type ClaudePaths } from '../lib/claude-paths'
import { readJson, readJsonSync, writeJsonAtomic } from '../lib/json-file'
import { decryptSecret, encryptSecret } from '../lib/secrets'
import { TypedEmitter } from '../lib/typed-emitter'
import { AUTH_OVERRIDE_ENV } from './claude-cli'
import { fingerprintOf, type LoginProfile, type LoginProfiles } from './login-profiles'

interface StoredAccount {
  id: string
  name: string
  kind: AccountKind
  color: string
  /** Only set when the user picked the directory; otherwise the app-managed profile dir is used. */
  configDir: string | null
  defaultCwd: string | null
  extraArgs: string[]
  createdAt: string
  /** base64 of the OS-encrypted secret */
  secret: string | null
  secretHint: string | null
  /** Who should log in here, e.g. after an import from cswap. Missing in files of older versions. */
  expectedLogin?: ExpectedLogin | null
}

interface AccountsFile {
  version: 1
  accounts: StoredAccount[]
}

interface OAuthCredentials {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  subscriptionType?: string | null
  rateLimitTier?: string | null
  scopes?: string[]
}

export interface GlobalConfig {
  oauthAccount?: {
    accountUuid?: string
    emailAddress?: string
    displayName?: string
    organizationUuid?: string
    organizationName?: string
    organizationType?: string
  }
  cachedUsageUtilization?: unknown
}

/** Items copied from ~/.claude into a new profile when the user asks for it. */
const SHAREABLE_ITEMS = ['settings.json', 'keybindings.json', 'CLAUDE.md', 'skills', 'commands', 'agents', 'rules']

type Events = { changed: [accounts: Account[]] }

export interface AccountCredentials {
  kind: AccountKind
  /** OAuth access token (oauth/system accounts) — only for read-only API calls like usage. */
  accessToken: string | null
  accessTokenExpiresAt: number | null
  /** Decrypted long-lived token or API key (token/apiKey accounts). */
  secret: string | null
  paths: ClaudePaths
  accountUuid: string | null
  /**
   * Identifies the login behind the credentials (person + organization, or the stored secret).
   * Changes when another login takes over the account's files, e.g. after a switch with cswap.
   * `null` while it is not known yet.
   */
  loginKey: string | null
}

export class AccountService extends TypedEmitter<Events> {
  private readonly file: string
  private readonly profilesDir: string
  private stored: StoredAccount[] = []
  /** Decrypted tokens and API keys by account id. Only ever in memory, decrypted once at start. */
  private readonly secrets = new Map<string, string>()
  private snapshot: Account[] = []
  private fingerprint = ''
  private pollTimer: NodeJS.Timeout | null = null

  constructor(
    userDataDir: string,
    private readonly profiles: LoginProfiles,
  ) {
    super()
    this.file = join(userDataDir, 'accounts.json')
    this.profilesDir = join(userDataDir, 'profiles')
  }

  async init(): Promise<void> {
    await this.profiles.init()
    this.profiles.on('resolved', () => this.rebuild())
    const data = await readJson<AccountsFile>(this.file)
    this.stored = Array.isArray(data?.accounts) ? data.accounts.filter(isStoredAccount) : []
    if (!this.stored.some((a) => a.id === SYSTEM_ACCOUNT_ID)) {
      this.stored.unshift({
        id: SYSTEM_ACCOUNT_ID,
        name: 'Standard (~/.claude)',
        kind: 'system',
        color: ACCOUNT_COLORS[0],
        configDir: null,
        defaultCwd: null,
        extraArgs: [],
        createdAt: new Date().toISOString(),
        secret: null,
        secretHint: null,
        expectedLogin: null,
      })
      await this.persist()
    }
    await this.loadSecrets()
    this.rebuild()
    // Credentials change when Claude Code logs in, logs out or refreshes a token.
    this.pollTimer = setInterval(() => this.refresh(), 15000)
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
  }

  list(): Account[] {
    return this.snapshot.map((a) => structuredClone(a))
  }

  get(id: string): Account {
    const account = this.snapshot.find((a) => a.id === id)
    if (!account) throw new Error(`Konto „${id}“ existiert nicht.`)
    return structuredClone(account)
  }

  /** Re-reads credentials / identity from disk and emits `changed` when something differs. */
  refresh(): Account[] {
    this.rebuild()
    return this.list()
  }

  /** `expectedLogin` is only set by the app itself (cswap import), never through IPC or the API. */
  async create(input: AccountCreateInput, options: { expectedLogin?: ExpectedLogin | null } = {}): Promise<Account> {
    const name = input.name.trim()
    if (!name) throw new Error('Bitte gib einen Namen an.')
    if (!['oauth', 'token', 'apiKey'].includes(input.kind)) throw new Error('Unbekannter Kontotyp.')
    const secret = input.secret?.trim() ?? ''
    if (input.kind === 'token' && !secret.startsWith('sk-ant-')) {
      throw new Error('Der Token muss mit „sk-ant-“ beginnen (erzeugt mit `claude setup-token`).')
    }
    if (input.kind === 'apiKey' && !secret.startsWith('sk-ant-')) {
      throw new Error('Der API-Key muss mit „sk-ant-“ beginnen.')
    }

    const id = randomUUID()
    // Before anything is created: without OS encryption nothing is stored at all.
    const encrypted = secret ? await encryptSecret(secret) : null
    let configDir: string | null = null
    if (input.configDir?.trim()) {
      configDir = resolve(input.configDir.trim())
      if (!isAbsolute(configDir)) throw new Error('Der Konfigurationsordner muss ein absoluter Pfad sein.')
      if (this.stored.some((a) => a.configDir && samePath(a.configDir, configDir!))) {
        throw new Error('Dieser Konfigurationsordner wird bereits von einem anderen Konto verwendet.')
      }
      if (samePath(configDir, defaultClaudeConfigDir())) {
        throw new Error('~/.claude gehört zum Standard-Konto. Wähle einen anderen Ordner.')
      }
    }
    const effectiveDir = configDir ?? join(this.profilesDir, id)
    const dirExisted = existsSync(effectiveDir)
    await mkdir(effectiveDir, { recursive: true })
    if (input.importSettings) {
      try {
        await this.importSharedItems(effectiveDir)
      } catch (error) {
        // The account isn't created, so its folder doesn't stay behind either.
        if (!dirExisted) await rm(effectiveDir, { recursive: true, force: true })
        throw error
      }
    }

    const account: StoredAccount = {
      id,
      name,
      kind: input.kind,
      color: input.color || ACCOUNT_COLORS[this.stored.length % ACCOUNT_COLORS.length],
      configDir,
      defaultCwd: input.defaultCwd?.trim() || null,
      extraArgs: sanitizeArgs(input.extraArgs),
      createdAt: new Date().toISOString(),
      secret: encrypted,
      secretHint: secret ? maskSecret(secret) : null,
      expectedLogin: toExpectedLogin(options.expectedLogin),
    }
    this.stored.push(account)
    if (secret) this.secrets.set(id, secret)
    await this.persist()
    this.rebuild(true)
    return this.get(id)
  }

  async update(id: string, patch: AccountUpdateInput): Promise<Account> {
    const account = this.stored.find((a) => a.id === id)
    if (!account) throw new Error(`Konto „${id}“ existiert nicht.`)
    // Check and encrypt first, so a failure leaves the account untouched.
    const name = patch.name?.trim()
    if (patch.name !== undefined && !name) throw new Error('Bitte gib einen Namen an.')
    const secret = patch.secret?.trim() || null
    let encrypted: string | null = null
    if (secret) {
      if (account.kind !== 'token' && account.kind !== 'apiKey') {
        throw new Error('Nur Token- und API-Key-Konten speichern ein Secret.')
      }
      if (!secret.startsWith('sk-ant-')) throw new Error('Das Secret muss mit „sk-ant-“ beginnen.')
      encrypted = await encryptSecret(secret)
    }
    if (name) account.name = name
    if (patch.color !== undefined && /^#[0-9a-f]{6}$/i.test(patch.color)) account.color = patch.color
    if (patch.defaultCwd !== undefined) account.defaultCwd = patch.defaultCwd?.trim() || null
    if (patch.extraArgs !== undefined) account.extraArgs = sanitizeArgs(patch.extraArgs)
    if (patch.expectedLogin === null) account.expectedLogin = null
    if (secret && encrypted) {
      account.secret = encrypted
      account.secretHint = maskSecret(secret)
      this.secrets.set(id, secret)
    }
    await this.persist()
    this.rebuild(true)
    return this.get(id)
  }

  async remove(id: string, options: { deleteConfigDir: boolean }): Promise<void> {
    if (id === SYSTEM_ACCOUNT_ID) throw new Error('Das Standard-Konto kann nicht entfernt werden.')
    const account = this.stored.find((a) => a.id === id)
    if (!account) return
    this.stored = this.stored.filter((a) => a.id !== id)
    this.secrets.delete(id)
    await this.persist()
    this.profiles.forget(id)
    // Only ever delete directories the app created itself.
    if (options.deleteConfigDir && !account.configDir) {
      const dir = join(this.profilesDir, id)
      if (dir.startsWith(this.profilesDir) && existsSync(dir)) await rm(dir, { recursive: true, force: true })
    }
    this.rebuild(true)
  }

  /** Paths Claude Code uses for this account. */
  paths(id: string): ClaudePaths {
    const account = this.requireStored(id)
    if (account.kind === 'system') {
      const envDir = process.env.CLAUDE_CONFIG_DIR
      return claudePaths(envDir ? resolve(envDir) : defaultClaudeConfigDir(), Boolean(envDir))
    }
    return claudePaths(account.configDir ?? join(this.profilesDir, account.id), true)
  }

  /** Everything needed to talk to Anthropic on behalf of this account. Never sent to the renderer. */
  credentials(id: string): AccountCredentials {
    const account = this.requireStored(id)
    const paths = this.paths(id)
    const oauth = readOAuth(paths.credentialsFile)
    const config = readGlobalConfig(paths.globalConfigFile)
    const secret = this.secrets.get(account.id) ?? null
    const profile = this.profileOf(account, oauth, false)
    let loginKey: string | null = null
    if (account.kind === 'token' || account.kind === 'apiKey') loginKey = secret ? `secret:${fingerprintOf(secret)}` : null
    else if (profile) loginKey = `login:${profile.accountUuid}/${profile.organizationUuid ?? ''}`
    return {
      kind: account.kind,
      accessToken: oauth?.accessToken ?? null,
      accessTokenExpiresAt: typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null,
      secret,
      paths,
      accountUuid: profile?.accountUuid ?? config?.oauthAccount?.accountUuid ?? null,
      loginKey,
    }
  }

  /** Makes sure the login behind the account's current access token is known (one request per token). */
  async resolveLogin(id: string): Promise<void> {
    const account = this.requireStored(id)
    if (account.kind !== 'system' && account.kind !== 'oauth') return
    const oauth = readOAuth(this.paths(id).credentialsFile)
    if (oauth?.accessToken && !isExpired(oauth)) await this.profiles.resolve(id, oauth.accessToken)
  }

  /**
   * What Anthropic says about the login of a browser account, when known. Setup tokens are
   * inference-only and can't be asked; an expired token is only matched against earlier answers.
   */
  private profileOf(account: StoredAccount, oauth: OAuthCredentials | null, fetch: boolean): LoginProfile | null {
    if (account.kind !== 'system' && account.kind !== 'oauth') return null
    if (!oauth?.accessToken) return null
    return this.profiles.peek(account.id, oauth.accessToken, fetch && !isExpired(oauth))
  }

  /**
   * Environment changes for launching `claude` as this account.
   * `set` values must be added, `unset` keys removed from the inherited environment.
   */
  /**
   * Environment for Claude Code with the config dir of `id` and the credentials of `authId`.
   * A token or API key in the environment wins over the login stored in the config dir.
   */
  launchEnv(id: string, authId = id): { set: Record<string, string>; unset: string[] } {
    const account = this.requireStored(id)
    const auth = this.requireStored(authId)
    if (auth.id !== account.id && !canLendCredentials(auth.kind)) {
      throw new Error(`„${auth.name}“ ist per Browser angemeldet. Dieser Login funktioniert nur im eigenen Ordner.`)
    }
    if (account.kind === 'system' && auth.id === account.id) return { set: {}, unset: [] }
    const set: Record<string, string> = account.kind === 'system' ? {} : { CLAUDE_CONFIG_DIR: this.paths(id).configDir }
    const unset = [...AUTH_OVERRIDE_ENV]
    if (auth.kind === 'token' || auth.kind === 'apiKey') {
      const secret = this.secrets.get(auth.id)
      if (!secret) throw new Error(`Für „${auth.name}“ ist kein gültiges Secret gespeichert. Bitte neu eintragen.`)
      set[auth.kind === 'token' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = secret
    }
    return { set, unset }
  }

  private requireStored(id: string): StoredAccount {
    const account = this.stored.find((a) => a.id === id)
    if (!account) throw new Error(`Konto „${id}“ existiert nicht.`)
    return account
  }

  /** Decrypts the stored secrets once; values the OS wants re-encrypted are stored anew. */
  private async loadSecrets(): Promise<void> {
    let changed = false
    for (const account of this.stored) {
      if (!account.secret) continue
      const decrypted = await decryptSecret(account.secret)
      if (!decrypted) {
        console.warn(`[accounts] secret of „${account.name}“ could not be decrypted`)
        continue
      }
      this.secrets.set(account.id, decrypted.plain)
      if (decrypted.reEncrypted) {
        account.secret = decrypted.reEncrypted
        changed = true
      }
    }
    if (changed) await this.persist()
  }

  /** All or nothing: when an item fails, the items copied so far are removed again. */
  private async importSharedItems(targetDir: string): Promise<void> {
    const source = defaultClaudeConfigDir()
    const copied: string[] = []
    for (const item of SHAREABLE_ITEMS) {
      const from = join(source, item)
      const to = join(targetDir, item)
      try {
        await stat(from)
      } catch {
        continue
      }
      if (existsSync(to)) continue
      copied.push(to)
      try {
        await copyShared(from, to)
      } catch (error) {
        for (const path of copied) await rm(path, { recursive: true, force: true })
        throw new Error(`„${item}“ konnte nicht aus ~/.claude übernommen werden: ${(error as Error).message}`)
      }
    }
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.file, { version: 1, accounts: this.stored } satisfies AccountsFile)
  }

  private rebuild(forceEmit = false): void {
    const next = this.stored.map((a) => this.toAccount(a))
    const fingerprint = JSON.stringify(next)
    if (!forceEmit && fingerprint === this.fingerprint) return
    this.snapshot = next
    this.fingerprint = fingerprint
    this.emit('changed', this.list())
  }

  private toAccount(stored: StoredAccount): Account {
    const paths = this.paths(stored.id)
    const oauth = readOAuth(paths.credentialsFile)
    const config = readGlobalConfig(paths.globalConfigFile)
    const identity = buildIdentity(this.profileOf(stored, oauth, true), config, oauth)
    let authState: AuthState = 'missing'
    let tokenExpiresAt: string | null = null
    if (stored.kind === 'token' || stored.kind === 'apiKey') {
      // A secret that can't be decrypted (e.g. copied from another Windows user) is as good as none.
      authState = this.secrets.has(stored.id) ? 'ok' : 'missing'
    } else if (oauth?.accessToken) {
      const expires = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null
      tokenExpiresAt = expires ? new Date(expires).toISOString() : null
      authState = expires !== null && expires <= Date.now() ? 'expired' : 'ok'
    }
    return {
      id: stored.id,
      name: stored.name,
      kind: stored.kind,
      color: stored.color,
      configDir: paths.configDir,
      customConfigDir: stored.kind === 'system' || stored.configDir !== null,
      defaultCwd: stored.defaultCwd,
      extraArgs: [...stored.extraArgs],
      createdAt: stored.createdAt,
      hasSecret: Boolean(stored.secret),
      secretHint: stored.secretHint,
      authState,
      identity,
      tokenExpiresAt,
      expectedLogin: toExpectedLogin(stored.expectedLogin),
    }
  }
}

const lastGoodConfig = new Map<string, GlobalConfig>()

/**
 * Reads Claude Code's global config. Claude Code rewrites this file often; if we catch it
 * mid-write (invalid JSON) the last successfully parsed version is used instead.
 */
export function readGlobalConfig(file: string): GlobalConfig | null {
  const config = readJsonSync<GlobalConfig>(file)
  if (config) {
    lastGoodConfig.set(file, config)
    return config
  }
  return existsSync(file) ? (lastGoodConfig.get(file) ?? null) : null
}

/**
 * Prefers Anthropic's answer for the current token. Claude Code's config is only a fallback, and
 * only when it fits the plan of the stored credentials: it may still describe the previous login.
 */
function buildIdentity(profile: LoginProfile | null, config: GlobalConfig | null, oauth: OAuthCredentials | null): AccountIdentity {
  const subscriptionType = oauth?.subscriptionType ?? null
  const rateLimitTier = oauth?.rateLimitTier ?? null
  if (profile) {
    return {
      email: profile.email,
      displayName: profile.displayName,
      organizationUuid: profile.organizationUuid,
      organizationName: profile.organizationName,
      organizationType: profile.organizationType,
      subscriptionType,
      rateLimitTier,
    }
  }
  const stored = config?.oauthAccount
  if (!stored || !planMatches(stored.organizationType, subscriptionType)) {
    return {
      email: null,
      displayName: null,
      organizationUuid: null,
      organizationName: null,
      organizationType: null,
      subscriptionType,
      rateLimitTier,
    }
  }
  return {
    email: stored.emailAddress ?? null,
    displayName: stored.displayName ?? null,
    organizationUuid: stored.organizationUuid ?? null,
    organizationName: stored.organizationName ?? null,
    organizationType: stored.organizationType ?? null,
    subscriptionType,
    rateLimitTier,
  }
}

/** `claude_team` belongs to the plan `team` and so on. Unknown values count as a match. */
function planMatches(organizationType: string | undefined, subscriptionType: string | null): boolean {
  if (!organizationType?.startsWith('claude_') || !subscriptionType) return true
  return organizationType.slice('claude_'.length) === subscriptionType.toLowerCase()
}

function isExpired(oauth: OAuthCredentials): boolean {
  return typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()
}

function readOAuth(file: string): OAuthCredentials | null {
  const data = readJsonSync<{ claudeAiOauth?: OAuthCredentials }>(file)
  const oauth = data?.claudeAiOauth
  return oauth && typeof oauth === 'object' ? oauth : null
}

/** A clean copy of an expected login; `null` for anything malformed. */
function toExpectedLogin(value: unknown): ExpectedLogin | null {
  if (!value || typeof value !== 'object') return null
  const login = value as Record<keyof ExpectedLogin, unknown>
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const email = text(login.email)
  if (!email) return null
  return {
    email,
    accountUuid: text(login.accountUuid),
    organizationUuid: text(login.organizationUuid),
    organizationName: text(login.organizationName),
  }
}

/**
 * Copies a file or folder, but keeps links as links: skills installed by a skills manager are
 * links into its own folder and keep getting its updates.
 */
async function copyShared(from: string, to: string): Promise<void> {
  const info = await lstat(from)
  if (info.isSymbolicLink()) return copyLink(from, to)
  if (info.isDirectory()) {
    await mkdir(to)
    for (const name of await readdir(from)) await copyShared(join(from, name), join(to, name))
  } else if (info.isFile()) {
    await copyFile(from, to)
  }
}

/**
 * On Windows a folder link becomes a junction, which needs no admin rights (a symlink does:
 * EPERM). Where no link can be created, e.g. to a file, the content is copied. Broken links
 * are left out.
 */
async function copyLink(from: string, to: string): Promise<void> {
  const target = resolve(dirname(from), await readlink(from))
  const info = await stat(target).catch(() => null)
  if (!info) return
  try {
    await symlink(target, to, info.isDirectory() ? 'junction' : 'file')
  } catch {
    await copyShared(target, to)
  }
}

function sanitizeArgs(args: string[] | undefined): string[] {
  return (args ?? []).map((a) => String(a).trim()).filter(Boolean)
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== 'object') return false
  const a = value as Partial<StoredAccount>
  return (
    typeof a.id === 'string' &&
    typeof a.name === 'string' &&
    (a.kind === 'system' || a.kind === 'oauth' || a.kind === 'token' || a.kind === 'apiKey') &&
    typeof a.color === 'string' &&
    Array.isArray(a.extraArgs)
  )
}
