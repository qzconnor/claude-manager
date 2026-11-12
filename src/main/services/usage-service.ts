import { join } from 'node:path'
import { net } from 'electron'
import { MAX_STATS_DAYS } from '@shared/defaults'
import { mergeFolderStats } from '@shared/token-stats'
import type {
  AccountTokenStats,
  AccountUsage,
  DailyTokenStats,
  TokenCounts,
  UsageHistory,
  UsageReading,
  UsageStatus,
  UsageWindow,
} from '@shared/types'
import { addSample, forecastWindow, windowStart, type UsageSample } from '@shared/usage-forecast'
import { addReading, isUsageReading } from '@shared/usage-history'
import { readJson, writeJsonAtomic } from '../lib/json-file'
import { TypedEmitter } from '../lib/typed-emitter'
import { readGlobalConfig, type AccountCredentials, type AccountService } from './account-service'
import type { IndexerClient } from './indexer-client'
import { fingerprintOf } from './login-profiles'
import { renewOAuthLogin, type RenewResult } from './oauth-renewal'
import type { SettingsService } from './settings-service'
import { parseUsagePayload } from './usage-parser'
import type { TokenStatsResult, TokenTuple } from '../workers/indexer-protocol'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'
/** Manual refreshes are still throttled so nobody can hammer the endpoint by clicking. */
const MIN_MANUAL_INTERVAL_MS = 60_000
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000
const STAGGER_MS = 400
/**
 * How much earlier than one interval after the last the regular round may ask again. It comes a little
 * early or late each time (the accounts are asked one after another, renewing a token takes a moment);
 * without this every other round was skipped.
 */
const ROUND_SLACK_MS = 30_000
/** Claude Code is renewing the token itself right now: its new token is picked up shortly after. */
const RENEW_BUSY_RETRY_MS = 30_000

export interface LiveRecord {
  usage: AccountUsage
  nextAllowedAt: number
  /**
   * When the usage API was last asked, also when that failed (`usage.fetchedAt` stays at the last
   * answer with data); for data from the cache file, when it was fetched.
   */
  askedAt: number
  /** The login the data was fetched for (see `AccountCredentials.loginKey`). */
  loginKey: string | null
  /** Fingerprint of the token it was fetched with; unknown for data from the cache file. */
  tokenKey: string | null
}

/** The last failed attempt to renew an account's expired access token. */
interface Renewal {
  /** Fingerprint of the expired access token. A new one (e.g. after signing in) is tried right away. */
  tokenKey: string
  result: Exclude<RenewResult, 'renewed'>
  retryAt: number
}

interface CacheFile {
  version: 2
  records: Record<string, { usage: AccountUsage; loginKey: string | null }>
  /** Readings of the windows for the forecast, by `sampleKey`. */
  samples?: Record<string, UsageSample[]>
  /** Readings of the five-hour and the weekly window over the last days, by `sampleKey`. */
  history?: Record<string, UsageReading[]>
}

type Events = { changed: [usage: AccountUsage[]] }

export class UsageService extends TypedEmitter<Events> {
  private readonly cacheFile: string
  private live = new Map<string, LiveRecord>()
  private snapshot = new Map<string, AccountUsage>()
  /** When another login took over an account's files; older data belongs to the previous one. */
  private readonly loginChangedAt = new Map<string, number>()
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly renewals = new Map<string, Renewal>()
  /** Readings of each window of each account, oldest first: the pace for the forecast. */
  private samples = new Map<string, UsageSample[]>()
  /** Readings of the five-hour and the weekly window of each account over the last days: the curves of the usage page. */
  private readings = new Map<string, UsageReading[]>()
  private timer: NodeJS.Timeout | null = null
  private localTimer: NodeJS.Timeout | null = null
  /** For the moment the next window resets. */
  private resetTimer: NodeJS.Timeout | null = null

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
          const askedAt = record.usage.fetchedAt ? Date.parse(record.usage.fetchedAt) || 0 : 0
          this.live.set(id, { usage: record.usage, nextAllowedAt: 0, askedAt, loginKey: record.loginKey ?? null, tokenKey: null })
        }
      }
      for (const [key, list] of Object.entries(persisted.samples ?? {})) {
        if (Array.isArray(list)) this.samples.set(key, list.filter(isSample))
      }
      for (const [key, list] of Object.entries(persisted.history ?? {})) {
        if (Array.isArray(list)) this.readings.set(key, list.filter(isUsageReading))
      }
    }
    this.forgetRemoved()
    this.recompute()
    this.accounts.on('changed', () => {
      this.forgetRemoved()
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
    if (this.resetTimer) clearTimeout(this.resetTimer)
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

  /**
   * "Jetzt erneuern" on the accounts page: gets a new access token with the refresh token of the
   * browser login, also while the old one still works, and asks for the usage with it.
   */
  async renewLogin(accountId: string): Promise<RenewResult> {
    const creds = this.accounts.credentials(accountId)
    if (creds.kind !== 'system' && creds.kind !== 'oauth') throw new Error('Nur Browser-Logins lassen sich erneuern.')
    if (!creds.accessToken) throw new Error('Der Account ist nicht angemeldet.')
    const tokenKey = fingerprintOf(creds.accessToken)
    const result = await renewOAuthLogin(creds.paths.configDir, creds.paths.credentialsFile, this.userAgent, { force: true })
    if (result === 'renewed') this.renewals.delete(accountId)
    else if (result === 'rejected') this.renewals.set(accountId, { tokenKey, result, retryAt: Date.now() })
    // Shows the new expiry, or the login as dead.
    this.accounts.refresh()
    if (result === 'renewed') void this.refresh(accountId).catch(() => undefined)
    return result
  }

  /** How full the five-hour and the weekly limit of the account were over the last days. */
  history(accountId: string): UsageHistory {
    const of = (key: string) => structuredClone(this.readings.get(sampleKey(accountId, key)) ?? [])
    return { accountId, fiveHour: of('five_hour'), sevenDay: of('seven_day') }
  }

  async stats(accountId: string, days = 30): Promise<AccountTokenStats> {
    const span = Math.max(1, Math.min(MAX_STATS_DAYS, Math.floor(days)))
    const result = await this.indexer.request<TokenStatsResult>({
      method: 'tokenStats',
      projectsDir: this.accounts.paths(accountId).projectsDir,
      days: span,
    })
    const toCounts = (t: TokenTuple): TokenCounts => ({
      input: t[0],
      output: t[1],
      cacheCreation: t[2],
      cacheRead: t[3],
      messages: t[4],
      cost: t[5],
    })
    const byDay = new Map(result.days.map(([day, t]) => [day, toCounts(t)]))
    const dayList: DailyTokenStats[] = []
    const cursor = new Date()
    cursor.setHours(0, 0, 0, 0)
    cursor.setDate(cursor.getDate() - (span - 1))
    for (let i = 0; i < span; i++) {
      const pad = (n: number) => String(n).padStart(2, '0')
      const key = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`
      dayList.push({ date: key, ...(byDay.get(key) ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, messages: 0, cost: 0 }) })
      cursor.setDate(cursor.getDate() + 1)
    }
    const totals = dayList.reduce<TokenCounts>(
      (acc, d) => ({
        input: acc.input + d.input,
        output: acc.output + d.output,
        cacheCreation: acc.cacheCreation + d.cacheCreation,
        cacheRead: acc.cacheRead + d.cacheRead,
        messages: acc.messages + d.messages,
        cost: acc.cost + d.cost,
      }),
      { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, messages: 0, cost: 0 },
    )
    return {
      accountId,
      days: dayList,
      models: result.models.map(([model, t]) => ({ model, ...toCounts(t) })),
      folders: mergeFolderStats(
        result.folders.map(([path, projectKey, t, sessionCount]) => ({ path, projectKey, sessionCount, ...toCounts(t) })),
      ),
      sessions: result.sessions.map(({ tokens, ...session }) => ({ ...session, ...toCounts(tokens) })),
      totals,
      sessionCount: result.sessionCount,
      unpriced: result.unpriced,
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
      await this.renewExpired(accountId, manual)
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
    if (!dueNow(previous, tokenKey, manual, now)) {
      this.recompute()
      return
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
          askedAt: now,
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
          askedAt: now,
          loginKey: creds.loginKey,
          tokenKey,
        }
      }
    } catch (error) {
      record = {
        usage: { ...base, status: 'error', message: `Usage konnte nicht geladen werden: ${error instanceof Error ? error.message : String(error)}` },
        nextAllowedAt: now + Math.min(intervalMs, 2 * 60_000),
        askedAt: now,
        loginKey: creds.loginKey,
        tokenKey,
      }
    }
    record.usage.nextRefreshAt = new Date(record.nextAllowedAt).toISOString()
    this.live.set(accountId, record)
    // Computed first: the readings of the answer are saved with it.
    this.recompute()
    this.persist()
  }

  /**
   * Renews an expired access token with the refresh token, as Claude Code does when a session
   * starts. Without this, accounts that aren't in use would show limits from days ago. Only when
   * their usage is due anyway: tokens last hours, so that is about once per token.
   */
  private async renewExpired(accountId: string, manual: boolean): Promise<void> {
    const creds = this.accounts.credentials(accountId)
    if (creds.kind !== 'system' && creds.kind !== 'oauth') return
    if (!creds.accessToken || creds.accessTokenExpiresAt === null || creds.accessTokenExpiresAt > Date.now()) return
    const now = Date.now()
    const previous = this.live.get(accountId)
    if (previous && !isOtherLogin(previous.loginKey, creds.loginKey)) {
      if (now < (manual ? previous.askedAt + MIN_MANUAL_INTERVAL_MS : previous.nextAllowedAt)) return
    }
    const tokenKey = fingerprintOf(creds.accessToken)
    const last = this.renewals.get(accountId)
    if (last?.tokenKey === tokenKey && (last.result === 'rejected' || (!manual && now < last.retryAt))) return

    const result = await renewOAuthLogin(creds.paths.configDir, creds.paths.credentialsFile, this.userAgent)
    if (result === 'renewed' || result === 'rejected') {
      // Renewed: shows the account as signed in again and resolves the login of the new token.
      // Rejected: shows the login as dead.
      this.accounts.refresh()
    }
    if (result === 'renewed') {
      this.renewals.delete(accountId)
      return
    }
    const wait = result === 'busy' ? RENEW_BUSY_RETRY_MS : this.settings.get().claude.usageRefreshMinutes * 60_000
    this.renewals.set(accountId, { tokenKey, result, retryAt: now + wait })
  }

  private persist(): void {
    const records = Object.fromEntries([...this.live].map(([id, r]) => [id, { usage: r.usage, loginKey: r.loginKey }]))
    const known = new Set(this.accounts.list().map((a) => a.id))
    const ofKnown = <T>(map: Map<string, T>) => Object.fromEntries([...map].filter(([key]) => known.has(accountOfKey(key))))
    const file: CacheFile = { version: 2, records, samples: ofKnown(this.samples), history: ofKnown(this.readings) }
    void writeJsonAtomic(this.cacheFile, file).catch(() => undefined)
  }

  /** Forgets what is kept of accounts that were removed, also in the cache file. */
  private forgetRemoved(): void {
    const known = new Set(this.accounts.list().map((a) => a.id))
    let dropped = false
    for (const id of [...this.live.keys()]) {
      if (known.has(id)) continue
      this.live.delete(id)
      dropped = true
    }
    for (const map of [this.samples, this.readings]) {
      for (const key of [...map.keys()]) {
        if (known.has(accountOfKey(key))) continue
        map.delete(key)
        dropped = true
      }
    }
    for (const id of [...this.renewals.keys()]) if (!known.has(id)) this.renewals.delete(id)
    for (const id of [...this.loginChangedAt.keys()]) if (!known.has(id)) this.loginChangedAt.delete(id)
    if (dropped) this.persist()
  }

  /** Forgets what was fetched for the previous login of the account's files. */
  private dropLogin(accountId: string): void {
    this.live.delete(accountId)
    this.loginChangedAt.set(accountId, Date.now())
    for (const map of [this.samples, this.readings]) {
      for (const key of [...map.keys()]) if (accountOfKey(key) === accountId) map.delete(key)
    }
    this.persist()
  }

  /**
   * Notes the windows' values as readings (once per time they were fetched) and adds the forecast
   * from them, the five-hour and the weekly one also to the history. Windows without data of their
   * own (no time) are left as they are.
   */
  private withForecasts(accountId: string, usage: AccountUsage): AccountUsage {
    const fetchedAt = usage.fetchedAt ? Date.parse(usage.fetchedAt) : NaN
    if (Number.isNaN(fetchedAt)) return usage
    const forecast = (window: UsageWindow | null): UsageWindow | null => {
      if (!window) return null
      const start = windowStart(window)
      if (start === null) return window
      const key = sampleKey(accountId, window.key)
      const samples = addSample(this.samples.get(key) ?? [], [fetchedAt, window.percent], start)
      this.samples.set(key, samples)
      if (window === usage.fiveHour || window === usage.sevenDay) {
        const reading: UsageReading = [fetchedAt, window.percent, Date.parse(window.resetsAt!)]
        this.readings.set(key, addReading(this.readings.get(key) ?? [], reading, window.key))
      }
      return { ...window, forecast: forecastWindow(window, samples) }
    }
    return {
      ...usage,
      fiveHour: forecast(usage.fiveHour),
      sevenDay: forecast(usage.sevenDay),
      scoped: usage.scoped.map((w) => forecast(w) ?? w),
    }
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
      result = { ...result, status: 'expired', message: expiredMessage(this.renewals.get(accountId)?.result) }
    }
    result.nextRefreshAt = live ? (this.live.get(accountId)?.usage.nextRefreshAt ?? null) : null
    return this.withForecasts(accountId, withoutPastWindows(result, Date.now()))
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
    this.scheduleReset()
  }

  /**
   * Computes again the moment the next window resets: its usage drops to 0 then, not with the next
   * round up to 30 seconds later, meanwhile showing the old percentage with „Reset jetzt“.
   */
  private scheduleReset(): void {
    if (this.resetTimer) clearTimeout(this.resetTimer)
    this.resetTimer = null
    const now = Date.now()
    const at = nextReset(this.snapshot.values(), now)
    // Beyond what a timer can wait, the regular rounds see to it.
    if (at === null || at - now > MAX_TIMEOUT_MS) return
    this.resetTimer = setTimeout(() => this.recompute(), at - now + RESET_GRACE_MS)
  }
}

/** The longest a Node timer waits; longer ones fire at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1
/** After the reset time, so it counts as past. */
const RESET_GRACE_MS = 250

/** When the next window of these accounts resets (ms); null when none has a reset ahead. */
export function nextReset(usages: Iterable<AccountUsage>, now: number): number | null {
  let next: number | null = null
  for (const usage of usages) {
    for (const window of [usage.fiveHour, usage.sevenDay, ...usage.scoped]) {
      const at = window?.resetsAt ? Date.parse(window.resetsAt) : NaN
      if (at > now && (next === null || at < next)) next = at
    }
  }
  return next
}

function sampleKey(accountId: string, windowKey: string): string {
  return `${accountId}\n${windowKey}`
}

function accountOfKey(key: string): string {
  return key.slice(0, key.indexOf('\n'))
}

function isSample(value: unknown): value is UsageSample {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n))
}

function expiredMessage(renewal: Renewal['result'] | undefined): string {
  switch (renewal) {
    case 'rejected':
      return 'Die Anmeldung ist abgelaufen und lässt sich nicht mehr erneuern. Melde dich über „Anmelden“ neu an.'
    case 'failed':
      return 'Access-Token abgelaufen, die Erneuerung ist fehlgeschlagen. Neuer Versuch beim nächsten Abruf.'
    default:
      return 'Access-Token abgelaufen. Er wird beim nächsten Abruf erneuert.'
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
/** Whether the usage of an account is asked for now (`manual`: the user asked for it). */
export function dueNow(previous: LiveRecord | undefined, tokenKey: string, manual: boolean, now: number): boolean {
  if (!previous) return true
  if (previous.usage.status === 'rate-limited' && now < previous.nextAllowedAt) return false
  if (worthAsking(previous, tokenKey)) return true
  // From the last request, not the last data: a failed one leaves that as it was.
  if (manual) return now >= previous.askedAt + MIN_MANUAL_INTERVAL_MS
  return now >= previous.nextAllowedAt - ROUND_SLACK_MS
}

function worthAsking(record: LiveRecord | undefined, tokenKey: string): boolean {
  if (!record) return true
  return record.tokenKey !== null && record.tokenKey !== tokenKey && record.usage.status !== 'ok'
}

/**
 * Older data can describe windows that have reset since: their usage is gone, and the next
 * window only starts with the next message. Without this, an account that wasn't asked for days
 * would still show the old percentage with „Reset jetzt“.
 */
function withoutPastWindows(usage: AccountUsage, now: number): AccountUsage {
  const isPast = (window: UsageWindow | null) => Boolean(window?.resetsAt && Date.parse(window.resetsAt) <= now)
  const reset = (window: UsageWindow): UsageWindow =>
    isPast(window) ? { ...window, percent: 0, resetsAt: null, severity: null } : window
  if (!isPast(usage.fiveHour) && !isPast(usage.sevenDay) && !usage.scoped.some(isPast)) return usage
  return {
    ...usage,
    fiveHour: usage.fiveHour && reset(usage.fiveHour),
    sevenDay: usage.sevenDay && reset(usage.sevenDay),
    scoped: usage.scoped.map(reset),
    // The split of the weekly usage by model belongs to the window that is over.
    breakdown: isPast(usage.sevenDay) ? [] : usage.breakdown,
  }
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
