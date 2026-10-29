import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { net } from 'electron'
import { readJson, writeJsonAtomic } from '../lib/json-file'
import { TypedEmitter } from '../lib/typed-emitter'

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const OAUTH_BETA = 'oauth-2025-04-20'
/** After a network or server error the token is asked about again later, not on every poll. */
const RETRY_MS = 5 * 60_000

/** Whose login an access token is, as Anthropic reports it. */
export interface LoginProfile {
  accountUuid: string
  email: string | null
  displayName: string | null
  organizationUuid: string | null
  organizationName: string | null
  /** e.g. `claude_pro`, `claude_max`, `claude_team` */
  organizationType: string | null
}

interface Entry {
  /** Hash of the access token the answer belongs to. */
  fingerprint: string
  /** `null` when Anthropic rejected the token (401/403): asking again would not help. */
  profile: LoginProfile | null
}

type Events = { resolved: [accountId: string] }

/**
 * Resolves OAuth access tokens to their account and organization. The `oauthAccount` block in
 * Claude Code's config is not reliable for that: account switchers like cswap swap the credentials,
 * and a Claude Code instance that is still running can write its own, older block back.
 * One request per token; Claude Code renews tokens every few hours.
 */
export class LoginProfiles extends TypedEmitter<Events> {
  private readonly file: string
  private entries = new Map<string, Entry>()
  private readonly inflight = new Map<string, Promise<LoginProfile | null>>()
  private readonly retryAt = new Map<string, number>()

  constructor(
    userDataDir: string,
    private readonly userAgent: string,
  ) {
    super()
    this.file = join(userDataDir, 'cache', 'login-profiles.json')
  }

  async init(): Promise<void> {
    const persisted = await readJson<Record<string, Entry>>(this.file)
    if (!persisted || typeof persisted !== 'object') return
    for (const [accountId, entry] of Object.entries(persisted)) {
      if (entry && typeof entry.fingerprint === 'string') this.entries.set(accountId, entry)
    }
  }

  /** The profile of `token` when it is known. With `fetch`, an unknown token is looked up in the background. */
  peek(accountId: string, token: string, fetch: boolean): LoginProfile | null {
    const entry = this.entries.get(accountId)
    if (entry?.fingerprint === fingerprintOf(token)) return entry.profile
    if (fetch) void this.resolve(accountId, token)
    return null
  }

  /** Looks the token up unless its profile is known, failed recently or is being fetched. */
  resolve(accountId: string, token: string): Promise<LoginProfile | null> {
    const fingerprint = fingerprintOf(token)
    const entry = this.entries.get(accountId)
    if (entry?.fingerprint === fingerprint) return Promise.resolve(entry.profile)
    const key = `${accountId}:${fingerprint}`
    const running = this.inflight.get(key)
    if (running) return running
    if ((this.retryAt.get(key) ?? 0) > Date.now()) return Promise.resolve(null)
    const pending = this.fetchProfile(token)
      .then((result) => {
        if (result === 'retry') {
          this.retryAt.set(key, Date.now() + RETRY_MS)
          return null
        }
        this.retryAt.delete(key)
        this.entries.set(accountId, { fingerprint, profile: result })
        void writeJsonAtomic(this.file, Object.fromEntries(this.entries)).catch(() => undefined)
        this.emit('resolved', accountId)
        return result
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, pending)
    return pending
  }

  forget(accountId: string): void {
    if (!this.entries.delete(accountId)) return
    void writeJsonAtomic(this.file, Object.fromEntries(this.entries)).catch(() => undefined)
  }

  private async fetchProfile(token: string): Promise<LoginProfile | null | 'retry'> {
    try {
      const response = await net.fetch(PROFILE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent,
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (response.status === 401 || response.status === 403) return null
      if (!response.ok) return 'retry'
      return parseProfile(await response.json()) ?? 'retry'
    } catch (error) {
      console.error('[profiles] lookup failed', error instanceof Error ? error.message : error)
      return 'retry'
    }
  }
}

/** A one-way hash, so the cache never contains the token itself. */
export function fingerprintOf(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32)
}

function parseProfile(data: unknown): LoginProfile | null {
  if (!data || typeof data !== 'object') return null
  const { account, organization } = data as { account?: unknown; organization?: unknown }
  if (!account || typeof account !== 'object') return null
  const a = account as Record<string, unknown>
  if (typeof a.uuid !== 'string' || !a.uuid) return null
  const o = organization && typeof organization === 'object' ? (organization as Record<string, unknown>) : {}
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null)
  return {
    accountUuid: a.uuid,
    email: text(a.email),
    displayName: text(a.display_name) ?? text(a.full_name),
    organizationUuid: text(o.uuid),
    organizationName: text(o.name),
    organizationType: text(o.organization_type),
  }
}
