import { randomBytes } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { net } from 'electron'
import { fingerprintOf } from './login-profiles'

/** Claude Code's OAuth client and token endpoint (as of Claude Code 2.1). */
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
/** Claude Code's lock rules (proper-lockfile): touched every 5 s while held, abandoned after a minute. */
const LOCK_STALE_MS = 60_000
const LOCK_TOUCH_MS = 5_000
const REQUEST_TIMEOUT_MS = 15_000

export type RenewResult =
  /** A valid access token is on disk now: renewed here, or by Claude Code in the meantime. */
  | 'renewed'
  /** Claude Code is renewing it right now, or the file changed while it was renewed here. */
  | 'busy'
  /** The login can't be renewed (refresh token missing, expired or revoked): only signing in again helps. */
  | 'rejected'
  /** Network or server error: worth another try later. */
  | 'failed'

interface StoredOAuth {
  accessToken?: unknown
  refreshToken?: unknown
  expiresAt?: unknown
  refreshTokenExpiresAt?: unknown
  scopes?: unknown
  clientId?: unknown
}

interface CredentialsFile {
  claudeAiOauth?: StoredOAuth
  [key: string]: unknown
}

/** Refresh tokens Anthropic refused (by hash): they never work again. */
const deadRefreshTokens = new Set<string>()

/**
 * Renews the expired access token of a browser login with its refresh token, the way Claude Code
 * does it at the start of a session: under Claude Code's own lock for the config folder, and the
 * new tokens are only written if the file still holds the refresh token that was used. A refresh
 * token works only once, so two processes must never use the same one. With `force` also a token
 * that still works ("Jetzt erneuern" on the accounts page); a session that still holds the old one
 * reads the new one from the file, as after a renewal by another Claude Code.
 */
export async function renewOAuthLogin(
  configDir: string,
  credentialsFile: string,
  userAgent: string,
  { force = false }: { force?: boolean } = {},
): Promise<RenewResult> {
  const before = (await readCredentials(credentialsFile))?.claudeAiOauth
  if (!before) return force ? 'rejected' : 'renewed'
  if (!force && !isExpired(before)) return 'renewed'
  if (!isRenewable(before)) return 'rejected'

  const lock = await acquireLocks(configDir)
  if (!lock) return 'busy'
  try {
    // Claude Code may have renewed it while the lock was being taken.
    const file = await readCredentials(credentialsFile)
    const current = file?.claudeAiOauth
    if (!file || !current) return 'rejected'
    if (current.accessToken !== before.accessToken || (!force && !isExpired(current))) return 'renewed'
    if (!isRenewable(current)) return 'rejected'

    const tokens = await requestTokens(current, userAgent)
    if (typeof tokens === 'string') return tokens

    const latest = await readCredentials(credentialsFile)
    // Someone wrote the file without the lock, e.g. a new sign-in: that login stays.
    if (!latest?.claudeAiOauth || latest.claudeAiOauth.refreshToken !== current.refreshToken) return 'busy'
    await writeCredentials(credentialsFile, { ...latest, claudeAiOauth: { ...latest.claudeAiOauth, ...tokens } })
    return 'renewed'
  } finally {
    await lock.release()
  }
}

function isExpired(oauth: StoredOAuth): boolean {
  return typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()
}

/**
 * Whether the login of a credentials file can still get new access tokens: its refresh token is
 * there, hasn't expired and wasn't refused. Without, only signing in again helps once the access
 * token expires.
 */
export function canRenew(oauth: object): boolean {
  return isRenewable(oauth as StoredOAuth)
}

/** A refresh token that may still work, and the scopes to ask for (Claude Code's condition). */
function isRenewable(oauth: StoredOAuth): oauth is StoredOAuth & { refreshToken: string; scopes: string[] } {
  if (typeof oauth.refreshToken !== 'string' || !oauth.refreshToken) return false
  if (!Array.isArray(oauth.scopes) || !oauth.scopes.every((s) => typeof s === 'string') || !oauth.scopes.includes('user:inference')) {
    return false
  }
  if (typeof oauth.refreshTokenExpiresAt === 'number' && oauth.refreshTokenExpiresAt <= Date.now()) return false
  return !deadRefreshTokens.has(fingerprintOf(oauth.refreshToken))
}

async function requestTokens(
  oauth: StoredOAuth & { refreshToken: string; scopes: string[] },
  userAgent: string,
): Promise<Partial<StoredOAuth> | 'rejected' | 'failed'> {
  let response: Response
  try {
    response = await net.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: typeof oauth.clientId === 'string' && oauth.clientId ? oauth.clientId : CLIENT_ID,
        scope: oauth.scopes.join(' '),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    console.error('[oauth] renewal failed', error instanceof Error ? error.message : error)
    return 'failed'
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    // Used, revoked or expired: only a new sign-in helps, asking again would not.
    if ((response.status === 400 || response.status === 401) && data?.error === 'invalid_grant') {
      deadRefreshTokens.add(fingerprintOf(oauth.refreshToken))
      return 'rejected'
    }
    console.error(`[oauth] renewal answered HTTP ${response.status}`, typeof data?.error === 'string' ? data.error : '')
    return 'failed'
  }
  const accessToken = data?.access_token
  const expiresIn = data?.expires_in
  if (typeof accessToken !== 'string' || !accessToken || typeof expiresIn !== 'number' || !(expiresIn > 0)) {
    console.error('[oauth] renewal answered without a token')
    return 'failed'
  }
  const now = Date.now()
  const tokens: Partial<StoredOAuth> = {
    accessToken,
    // Without a new one the old refresh token stays valid.
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : oauth.refreshToken,
    expiresAt: now + expiresIn * 1000,
  }
  if (typeof data.scope === 'string' && data.scope.trim()) tokens.scopes = data.scope.trim().split(/\s+/)
  if (typeof data.refresh_token_expires_in === 'number' && data.refresh_token_expires_in > 0) {
    tokens.refreshTokenExpiresAt = now + data.refresh_token_expires_in * 1000
  }
  return tokens
}

async function readCredentials(file: string): Promise<CredentialsFile | null> {
  try {
    const text = await readFile(file, 'utf8')
    const data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as CredentialsFile) : null
  } catch {
    return null
  }
}

/** Atomically, readable only by the user (Claude Code's own file mode). */
async function writeCredentials(file: string, data: CredentialsFile): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
  // Windows can briefly lock the target (antivirus, indexer) — retry a few times.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file)
      return
    } catch (error) {
      if (attempt >= 5) {
        await rm(tmp, { force: true })
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

/**
 * Claude Code's locks for renewing a login: `.oauth_refresh.lock` in the config folder, and the
 * older `<folder>.lock` next to it that earlier versions use. Both are directories.
 */
async function acquireLocks(configDir: string): Promise<{ release: () => Promise<void> } | null> {
  const current = join(configDir, '.oauth_refresh.lock')
  const legacy = `${await realpath(configDir).catch(() => configDir)}.lock`
  if ((await acquireLock(current)) !== 'acquired') return null
  const held = [current]
  const legacyResult = await acquireLock(legacy)
  if (legacyResult === 'busy') {
    await rm(current, { recursive: true, force: true }).catch(() => undefined)
    return null
  }
  // Like Claude Code: without the legacy lock (e.g. no write access next to the folder) it goes on.
  if (legacyResult === 'acquired') held.push(legacy)
  // A lock that is touched is still held; Claude Code doesn't take it over then.
  const timer = setInterval(() => {
    const now = new Date()
    for (const dir of held) void utimes(dir, now, now).catch(() => undefined)
  }, LOCK_TOUCH_MS)
  return {
    release: async () => {
      clearInterval(timer)
      for (const dir of held.reverse()) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

async function acquireLock(dir: string): Promise<'acquired' | 'busy' | 'error'> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(dir)
      return 'acquired'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'error'
      // A lock nobody touched for a minute belongs to a process that ended without releasing it.
      const info = await stat(dir).catch(() => null)
      if (info && Date.now() - info.mtimeMs <= LOCK_STALE_MS) return 'busy'
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  return 'busy'
}
