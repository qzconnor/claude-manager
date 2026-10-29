import { join } from 'node:path'
import { net } from 'electron'
import type { AccountTokenStats, AccountUsage, DailyTokenStats, TokenCounts, UsageStatus } from '@shared/types'
import { readJson, writeJsonAtomic } from '../lib/json-file'
import { TypedEmitter } from '../lib/typed-emitter'
import { readGlobalConfig, type AccountCredentials, type AccountService } from './account-service'
import type { IndexerClient } from './indexer-client'
import { fingerprintOf } from './login-profiles'
import type { SettingsService } from './settings-service'
import { parseUsagePayload } from './usage-parser'
import type { TokenStatsResult } from '../workers/indexer-protocol'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'
/** Manual refreshes are still throttled so nobody can hammer the endpoint by clicking. */
const MIN_MANUAL_INTERVAL_MS = 60_000
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000
const STAGGER_MS = 400

interface LiveRecord {
  usage: AccountUsage
  nextAllowedAt: number
  /** The login the data was fetched for (see `AccountCredentials.loginKey`). */
  loginKey: string | null
  /** Fingerprint of the token it was fetched with; unknown for data from the cache file. */
  tokenKey: string | null
}

interface CacheFile {
  version: 2
  records: Record<string, { usage: AccountUsage; loginKey: string | null }>
}

type Events = { changed: [usage: AccountUsage[]] }

export class UsageService extends TypedEmitter<Events> {
  private readonly cacheFile: string
  private live = new Map<string, LiveRecord>()
  private snapshot = new Map<string, AccountUsage>()
  /** When another login took over an account's files; older data belongs to the previous one. */
  private readonly loginChangedAt = new Map<string, number>()
  private readonly inflight = new Map<string, Promise<void>>()
  private timer: NodeJS.Timeout | null = null
  private localTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly accounts: AccountService,
    private readonly settings: SettingsService,
    private readonly indexer: IndexerClient,
    userDataDir: string,
    private readonly userAgent: string,
  ) {
    super()
    this.cacheFile = join(userDataDir, 'cache', 'usage.json')
  }

  async init(): Promise<void> {
    const persisted = await readJson<CacheFile>(this.cacheFile)
    // Older caches don't say which login the data belongs to; they are fetched again on start anyway.
    if (persisted?.version === 2 && persisted.records && typeof persisted.records === 'object') {
      for (const [id, record] of Object.entries(persisted.records)) {
        if (record?.usage && typeof record.usage === 'object') {
          this.live.set(id, { usage: record.usage, nextAllowedAt: 0, loginKey: record.loginKey ?? null, tokenKey: null })
        }
      }
    }
    this.recompute()
    this.accounts.on('changed', () => {
      this.recompute()
      this.fetchNewLogins()
    })
    this.settings.on('changed', (next, previous) => {
      if (next.claude.usageRefreshMinutes !== previous.claude.usageRefreshMinutes) this.schedule()
    })
    // Claude Code keeps its own usage cache up to date while it runs — pick that up cheaply.
    this.localTimer = setInterval(() => this.recompute(), 30_000)
    this.schedule()
    void this.refreshAll(false)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.localTimer) clearInterval(this.localTimer)
  }

  getAll(): AccountUsage[] {
    return this.accounts.list().map((a) => structuredClone(this.snapshot.get(a.id) ?? this.compute(a.id)))
  }

  /** Fetches live usage (respecting throttling) and returns the new state for all accounts. */
  async refresh(accountId?: string): Promise<AccountUsage[]> {
    if (accountId) await this.refreshOne(accountId, true)
    else await this.refreshAll(true)
    return this.getAll()
  }

  async stats(accountId: string, days = 30): Promise<AccountTokenStats> {
    const span = Math.max(1, Math.min(365, Math.floor(days)))
    const result = await this.indexer.request<TokenStatsResult>({
      method: 'tokenStats',
      projectsDir: this.accounts.paths(accountId).projectsDir,
      days: span,
    })
    const toCounts = (t: [number, number, number, number, number]): TokenCounts => ({
      input: t[0],
      output: t[1],
      cacheCreation: t[2],
      cacheRead: t[3],
      messages: t[4],
    })
    const byDay = new Map(result.days.map(([day, t]) => [day, toCounts(t)]))
    const dayList: DailyTokenStats[] = []
    const cursor = new Date()
    cursor.setHours(0, 0, 0, 0)
    cursor.setDate(cursor.getDate() - (span - 1))
    for (let i = 0; i < span; i++) {
      const pad = (n: number) => String(n).padStart(2, '0')
      const key = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`
      dayList.push({ date: key, ...(byDay.get(key) ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, messages: 0 }) })
      cursor.setDate(cursor.getDate() + 1)
    }
    const totals = dayList.reduce<TokenCounts>(
      (acc, d) => ({
        input: acc.input + d.input,
        output: acc.output + d.output,
        cacheCreation: acc.cacheCreation + d.cacheCreation,
        cacheRead: acc.cacheRead + d.cacheRead,
        messages: acc.messages + d.messages,
      }),
      { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, messages: 0 },
    )
    return {
      accountId,
      days: dayList,
      models: result.models.map(([model, t]) => ({ model, ...toCounts(t) })),
      totals,
      sessionCount: result.sessionCount,
      computedAt: new Date().toISOString(),
    }
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer)
    const minutes = this.settings.get().claude.usageRefreshMinutes
    this.timer = setInterval(() => void this.refreshAll(false), minutes * 60_000)
  }

  private async refreshAll(manual: boolean, ids = this.accounts.list().map((a) => a.id)): Promise<void> {
    for (const [index, id] of ids.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, STAGGER_MS))
      await this.refreshOne(id, manual)
    }
  }

  private refreshOne(accountId: string, manual: boolean): Promise<void> {
    let pending = this.inflight.get(accountId)
    if (!pending) {
      pending = this.fetchLive(accountId, manual)
        .catch((error) => console.error('[usage] refresh failed', error))
        .finally(() => this.inflight.delete(accountId))
      this.inflight.set(accountId, pending)
    }
    return pending
  }

  /**
   * Accounts with a token that wasn't asked yet, e.g. right after signing in: they get their usage
   * now instead of with the next regular round.
   */
  private fetchNewLogins(): void {
    const due = this.accounts.list().filter((account) => {
      if (this.inflight.has(account.id)) return false
      let token: string | null
      try {
        token = usableToken(this.accounts.credentials(account.id))
      } catch {
        return false
      }
      return token !== null && worthAsking(this.live.get(account.id), fingerprintOf(token))
    })
    if (due.length > 0) void this.refreshAll(false, due.map((account) => account.id))
  }

  private async fetchLive(accountId: string, manual: boolean): Promise<void> {
    let creds
    try {
      // The data is stored with the login it belongs to, so that login has to be known first.
      await this.accounts.resolveLogin(accountId)
      creds = this.accounts.credentials(accountId)
    } catch {
      return
    }
    if (creds.kind === 'apiKey') {
      this.recompute()
      return
    }
    const token = usableToken(creds)
    if (!token) {
      this.recompute()
      return
    }
    const tokenKey = fingerprintOf(token)

    const now = Date.now()
    let previous = this.live.get(accountId)
    if (previous && isOtherLogin(previous.loginKey, creds.loginKey)) {
      this.dropLogin(accountId)
      previous = undefined
    }
    if (previous) {
      const rateLimited = previous.usage.status === 'rate-limited' && now < previous.nextAllowedAt
      const fetchedAt = previous.usage.fetchedAt ? Date.parse(previous.usage.fetchedAt) : 0
      const minNext = worthAsking(previous, tokenKey) ? 0 : manual ? fetchedAt + MIN_MANUAL_INTERVAL_MS : previous.nextAllowedAt
      if (rateLimited || now < minNext) {
        this.recompute()
        return
      }
    }

    const intervalMs = this.settings.get().claude.usageRefreshMinutes * 60_000
    const base: AccountUsage = previous?.usage ?? emptyUsage(accountId, 'ok', 'none')
    let record: LiveRecord
    try {
      const response = await net.fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent,
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (response.ok) {
        const parsed = parseUsagePayload(await response.json())
        record = {
          usage: parsed
            ? { ...emptyUsage(accountId, 'ok', 'live'), ...parsed, fetchedAt: new Date().toISOString() }
            : { ...base, status: 'error', message: 'Unerwartete Antwort der Usage-API.' },
          nextAllowedAt: now + intervalMs,
          loginKey: creds.loginKey,
          tokenKey,
        }
      } else {
        const failure = describeHttpFailure(response.status, creds.kind === 'token')
        const retryAfter = Number(response.headers.get('retry-after'))
        const wait =
          response.status === 429
            ? Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : RATE_LIMIT_BACKOFF_MS
            : // A token without permission won't gain it — don't keep asking.
              failure.status === 'unsupported'
              ? 24 * 60 * 60_000
              : intervalMs
        record = {
          usage: { ...base, status: failure.status, message: failure.message },
          nextAllowedAt: now + wait,
          loginKey: creds.loginKey,
          tokenKey,
        }
      }
    } catch (error) {
      record = {
        usage: { ...base, status: 'error', message: `Usage konnte nicht geladen werden: ${error instanceof Error ? error.message : String(error)}` },
        nextAllowedAt: now + Math.min(intervalMs, 2 * 60_000),
        loginKey: creds.loginKey,
        tokenKey,
      }
    }
    record.usage.nextRefreshAt = new Date(record.nextAllowedAt).toISOString()
    this.live.set(accountId, record)
    this.persist()
    this.recompute()
  }

  private persist(): void {
    const records = Object.fromEntries([...this.live].map(([id, r]) => [id, { usage: r.usage, loginKey: r.loginKey }]))
    void writeJsonAtomic(this.cacheFile, { version: 2, records } satisfies CacheFile).catch(() => undefined)
  }

  /** Forgets what was fetched for the previous login of the account's files. */
  private dropLogin(accountId: string): void {
    this.live.delete(accountId)
    this.loginChangedAt.set(accountId, Date.now())
    this.persist()
  }

  /** Another login took over the account's files (e.g. switched with cswap): its limits are fetched right away. */
  private checkLogin(accountId: string): void {
    const recorded = this.live.get(accountId)?.loginKey ?? null
    if (!recorded) return
    let current: string | null
    try {
      current = this.accounts.credentials(accountId).loginKey
    } catch {
      return
    }
    if (!isOtherLogin(recorded, current)) return
    this.dropLogin(accountId)
    void this.refreshOne(accountId, false)
  }

  /** Combines the last live result with Claude Code's own cache — whichever is newer wins. */
  private compute(accountId: string): AccountUsage {
    let creds
    try {
      creds = this.accounts.credentials(accountId)
    } catch {
      return emptyUsage(accountId, 'no-credentials', 'none')
    }
    if (creds.kind === 'apiKey') {
      return {
        ...emptyUsage(accountId, 'unsupported', 'none'),
        message: 'API-Keys werden nach Verbrauch abgerechnet – es gibt keine Plan-Limits.',
      }
    }

    const live = this.live.get(accountId)?.usage ?? null
    const loginChangedAt = this.loginChangedAt.get(accountId) ?? 0
    const config = readGlobalConfig(creds.paths.globalConfigFile)
    const cached = config?.cachedUsageUtilization as
      | { fetchedAtMs?: unknown; accountUuid?: unknown; utilization?: unknown }
      | undefined
    let fromClaude: AccountUsage | null = null
    if (cached && typeof cached === 'object' && typeof cached.fetchedAtMs === 'number' && cached.fetchedAtMs > loginChangedAt) {
      const sameAccount = !creds.accountUuid || !cached.accountUuid || cached.accountUuid === creds.accountUuid
      const parsed = sameAccount ? parseUsagePayload(cached.utilization) : null
      if (parsed) {
        fromClaude = {
          ...emptyUsage(accountId, 'ok', 'claude-cache'),
          ...parsed,
          fetchedAt: new Date(cached.fetchedAtMs).toISOString(),
        }
      }
    }

    const liveHasData = Boolean(live && (live.fiveHour || live.sevenDay))
    const liveTime = live?.fetchedAt && liveHasData ? Date.parse(live.fetchedAt) : 0
    const claudeTime = fromClaude?.fetchedAt ? Date.parse(fromClaude.fetchedAt) : 0
    let result: AccountUsage
    if (fromClaude && claudeTime > liveTime) {
      // Keep the status/message of the last live attempt so problems stay visible.
      result = { ...fromClaude, status: live?.status ?? 'ok', message: live?.status === 'ok' ? null : (live?.message ?? null) }
    } else if (live) {
      result = { ...live }
    } else {
      result = emptyUsage(accountId, 'ok', 'none')
    }

    const expired = creds.kind !== 'token' && creds.accessTokenExpiresAt !== null && creds.accessTokenExpiresAt <= Date.now()
    if (creds.kind !== 'token' && !creds.accessToken) {
      result = { ...result, status: 'no-credentials', message: 'Nicht angemeldet. Melde dich über „Anmelden“ an.' }
    } else if (creds.kind === 'token' && !creds.secret) {
      result = { ...result, status: 'no-credentials', message: 'Kein Token gespeichert.' }
    } else if (expired) {
      result = {
        ...result,
        status: 'expired',
        message: 'Access-Token abgelaufen. Claude Code erneuert ihn beim nächsten Start einer Session dieses Kontos.',
      }
    }
    result.nextRefreshAt = live ? (this.live.get(accountId)?.usage.nextRefreshAt ?? null) : null
    return result
  }

  private recompute(): void {
    const next = new Map<string, AccountUsage>()
    for (const account of this.accounts.list()) {
      this.checkLogin(account.id)
      next.set(account.id, this.compute(account.id))
    }
    const changed =
      next.size !== this.snapshot.size ||
      [...next].some(([id, usage]) => JSON.stringify(usage) !== JSON.stringify(this.snapshot.get(id)))
    this.snapshot = next
    if (changed) this.emit('changed', this.getAll())
  }
}

/** Different logins, as far as both are known. */
function isOtherLogin(recorded: string | null, current: string | null): boolean {
  return Boolean(recorded && current && recorded !== current)
}

/** The token the usage API is asked with; `null` when the account has no usable one. */
function usableToken(creds: AccountCredentials): string | null {
  if (creds.kind === 'apiKey') return null
  if (creds.kind === 'token') return creds.secret
  const expired = creds.accessTokenExpiresAt !== null && creds.accessTokenExpiresAt <= Date.now()
  return expired ? null : creds.accessToken
}

/**
 * Whether a token is worth asking with before the next regular round: never asked yet, or a new
 * token (e.g. after signing in again) where the last one failed. Data from an earlier token of
 * the same login stays valid.
 */
function worthAsking(record: LiveRecord | undefined, tokenKey: string): boolean {
  if (!record) return true
  return record.tokenKey !== null && record.tokenKey !== tokenKey && record.usage.status !== 'ok'
}

function emptyUsage(accountId: string, status: UsageStatus, source: AccountUsage['source']): AccountUsage {
  return {
    accountId,
    status,
    source,
    fetchedAt: null,
    message: null,
    fiveHour: null,
    sevenDay: null,
    scoped: [],
    extra: null,
    breakdown: [],
    nextRefreshAt: null,
  }
}

function describeHttpFailure(status: number, isSetupToken: boolean): { status: UsageStatus; message: string } {
  if (status === 401) {
    return isSetupToken
      ? { status: 'unauthorized', message: 'Der Token ist ungültig oder wurde widerrufen.' }
      : { status: 'expired', message: 'Die Anmeldung ist abgelaufen. Starte eine Session oder melde dich neu an.' }
  }
  if (status === 403) {
    return isSetupToken
      ? {
          status: 'unsupported',
          message: 'Long-lived Tokens (claude setup-token) dürfen die Usage-API nicht abfragen. Lokale Statistiken sind trotzdem verfügbar.',
        }
      : { status: 'unauthorized', message: 'Keine Berechtigung für die Usage-API (HTTP 403).' }
  }
  if (status === 429) return { status: 'rate-limited', message: 'Usage-API Rate-Limit erreicht – neuer Versuch später.' }
  return { status: 'error', message: `Usage-API antwortete mit HTTP ${status}.` }
}
