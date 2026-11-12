import { net } from 'electron'
import type { Artifact, ArtifactAudience, ArtifactList, ArtifactListStatus } from '@shared/types'
import type { AccountService } from './account-service'
import { renewOAuthLogin } from './oauth-renewal'

/**
 * The artifacts of an account's login: the pages and documents Claude published on claude.ai with the
 * Artifact tool. Claude Code lists and manages them with the login's OAuth token at the same address,
 * with the same headers; the app does so for the page „Artefakte“.
 *
 * The newer list (`/artifacts`) serves only callers with a session's credential; like Claude Code, the
 * app then falls back to the older one (`/frames`), which every login gets.
 */
const API = 'https://api.anthropic.com/api/frame'
const OAUTH_BETA = 'oauth-2025-04-20'
/** Rows per page; the API takes at most 200. */
const PAGE_SIZE = 200
/** Pages per list at most: more than anyone keeps. */
const MAX_PAGES = 10
const TIMEOUT_MS = 15_000
/** How long a delete waits at most for the server to be ready again (409, 429, 503). */
const MAX_RETRY_AFTER_MS = 10_000
const RETRYABLE = new Set([409, 429, 503])
/** An artifact's id as in its link; nothing else is put into a path. */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const AUDIENCES: readonly ArtifactAudience[] = ['owner', 'users', 'org', 'public']
const MAX_TITLE = 300
const MAX_DESCRIPTION = 1000
/** Thumbnails come from the artifacts' own host, with a short-lived token in the link, never with the login's. */
const THUMB_HOST = '.frame.claudeusercontent.com'
const MAX_THUMB_BYTES = 2 * 1024 * 1024

export const ARTIFACT_URL = 'https://claude.ai/code/artifact/'

type Auth = { token: string } | { status: ArtifactListStatus; message: string }

interface Thumbs {
  light: string | null
  dark: string | null
}

interface Row {
  artifact: Artifact
  thumbs: Thumbs
}

interface Lane {
  rows: Row[]
  pinsEnabled: boolean
  truncated: boolean
}

export class ArtifactService {
  /** The thumbnails' links of the last list, per account and artifact: only these are fetched. */
  private readonly thumbs = new Map<string, Thumbs>()

  constructor(
    private readonly accounts: AccountService,
    private readonly userAgent: string,
    /** The installed Claude Code's version, which Claude Code sends along as its own. */
    private readonly clientVersion: () => Promise<string | null>,
    private readonly wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Own and shared artifacts of the account's login, most recently viewed first. */
  async list(accountId: string): Promise<ArtifactList> {
    const base: ArtifactList = {
      accountId,
      status: 'ok',
      message: null,
      artifacts: [],
      pinsEnabled: false,
      truncated: false,
      fetchedAt: new Date().toISOString(),
    }
    const auth = await this.auth(accountId)
    if (!('token' in auth)) return { ...base, ...auth }
    try {
      let lanes: Lane[]
      const own = await this.lane(auth.token, 'all')
      if (typeof own === 'number') {
        const frames = await this.frames(auth.token)
        if (typeof frames === 'number') return { ...base, ...listFailure(frames, this.accounts.credentials(accountId).kind) }
        lanes = [frames]
      } else {
        // The shared ones are a list of their own; without it the own ones are still worth showing.
        const shared = await this.lane(auth.token, 'shared')
        lanes = typeof shared === 'number' ? [own] : [own, shared]
      }
      const seen = new Set<string>()
      const rows: Row[] = []
      for (const row of lanes.flatMap((lane) => lane.rows)) {
        if (seen.has(row.artifact.id)) continue
        seen.add(row.artifact.id)
        rows.push(row)
      }
      rows.sort((a, b) => lastSeen(b.artifact) - lastSeen(a.artifact))
      for (const key of [...this.thumbs.keys()]) if (key.startsWith(`${accountId}\n`)) this.thumbs.delete(key)
      for (const row of rows) this.thumbs.set(`${accountId}\n${row.artifact.id}`, row.thumbs)
      return {
        ...base,
        artifacts: rows.map((row) => row.artifact),
        pinsEnabled: lanes[0]!.pinsEnabled,
        truncated: lanes.some((lane) => lane.truncated),
      }
    } catch (error) {
      return { ...base, status: 'error', message: `Die Artefakte konnten nicht geladen werden: ${errorText(error)}` }
    }
  }

  /**
   * The artifact's thumbnail of the last list as a `data:` URL (the window loads no pictures from
   * elsewhere); null without one, or when it can't be loaded.
   */
  async thumbnail(accountId: string, id: string, dark: boolean): Promise<string | null> {
    const thumbs = this.thumbs.get(`${accountId}\n${id}`)
    const url = (dark ? thumbs?.dark : null) ?? thumbs?.light ?? null
    if (!url) return null
    try {
      const response = await net.fetch(url, {
        headers: { 'User-Agent': this.userAgent },
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (!response.ok || !/^image\/(png|jpeg|webp|gif|avif)$/.test(type)) return null
      if (Number(response.headers.get('content-length')) > MAX_THUMB_BYTES) return null
      const bytes = Buffer.from(await response.arrayBuffer())
      return bytes.length > MAX_THUMB_BYTES ? null : `data:${type};base64,${bytes.toString('base64')}`
    } catch {
      return null
    }
  }

  /** Gives an own artifact another title. */
  async rename(accountId: string, id: string, title: string): Promise<void> {
    const name = title.replace(/\s+/g, ' ').trim()
    if (!name) throw new Error('Der Titel darf nicht leer sein.')
    if (name.length > MAX_TITLE) throw new Error(`Der Titel darf höchstens ${MAX_TITLE} Zeichen lang sein.`)
    const response = await this.send(accountId, 'POST', `/retitle/${checkedId(id)}`, { title: name })
    if (!response.ok) throw new Error(actionFailure(response.status, 'umbenannt'))
  }

  /** Deletes an own artifact for good; `gone` when it was deleted already. */
  async remove(accountId: string, id: string): Promise<'deleted' | 'gone'> {
    const path = `/${checkedId(id)}`
    let response = await this.send(accountId, 'DELETE', path)
    if (RETRYABLE.has(response.status)) {
      const seconds = Number(response.headers.get('retry-after'))
      await this.wait(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : 1000)
      response = await this.send(accountId, 'DELETE', path)
    }
    if (response.status === 404) return 'gone'
    if (!response.ok) throw new Error(actionFailure(response.status, 'gelöscht'))
    this.thumbs.delete(`${accountId}\n${id}`)
    return 'deleted'
  }

  /** Pins an artifact in the sidebar of claude.ai, or takes it off. */
  async setPinned(accountId: string, id: string, pinned: boolean): Promise<void> {
    const response = await this.send(accountId, pinned ? 'POST' : 'DELETE', `/favorite/${checkedId(id)}`)
    if (!response.ok) throw new Error(actionFailure(response.status, pinned ? 'angepinnt' : 'gelöst'))
  }

  private async send(accountId: string, method: string, path: string, body?: unknown): Promise<Response> {
    const auth = await this.auth(accountId)
    if (!('token' in auth)) throw new Error(auth.message)
    try {
      return await this.request(auth.token, method, path, body)
    } catch (error) {
      throw new Error(`claude.ai ist nicht erreichbar: ${errorText(error)}`)
    }
  }

  /** The login's token; an expired one is renewed first, as Claude Code does. */
  private async auth(accountId: string): Promise<Auth> {
    let creds = this.accounts.credentials(accountId)
    if (creds.kind === 'apiKey') {
      return { status: 'unavailable', message: 'Artefakte gehören zu einem Login bei claude.ai, nicht zu einem API-Key.' }
    }
    if (creds.kind === 'token') {
      return creds.secret ? { token: creds.secret } : { status: 'signed-out', message: 'Der Token des Accounts fehlt.' }
    }
    if (!creds.accessToken) return { status: 'signed-out', message: 'Der Account ist nicht angemeldet.' }
    if (creds.accessTokenExpiresAt !== null && creds.accessTokenExpiresAt <= Date.now()) {
      const result = await renewOAuthLogin(creds.paths.configDir, creds.paths.credentialsFile, this.userAgent)
      if (result === 'rejected') {
        return { status: 'signed-out', message: 'Die Anmeldung ist abgelaufen. Melde den Account neu an.' }
      }
      if (result !== 'renewed') {
        return { status: 'error', message: 'Die Anmeldung wird gerade erneuert. Versuche es gleich noch einmal.' }
      }
      this.accounts.refresh()
      creds = this.accounts.credentials(accountId)
      if (!creds.accessToken) return { status: 'signed-out', message: 'Der Account ist nicht angemeldet.' }
    }
    return { token: creds.accessToken }
  }

  /** One page by page (`all`: the own ones and those opened, `shared`: shared with the login). */
  private async lane(token: string, rel: 'all' | 'shared'): Promise<Lane | number> {
    const rows: Row[] = []
    let pinsEnabled = false
    let pageToken: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ rel, kind: 'page,document', sort: 'last_viewed', limit: String(PAGE_SIZE) })
      if (pageToken) query.set('page_token', pageToken)
      const response = await this.request(token, 'GET', `/artifacts?${query.toString()}`)
      // A later page that fails leaves what was listed so far.
      if (!response.ok) return page === 0 ? response.status : { rows, pinsEnabled, truncated: true }
      const data = (await response.json().catch(() => null)) as {
        artifacts?: unknown
        next_page_token?: unknown
        starsEnabled?: unknown
      } | null
      if (!data || !Array.isArray(data.artifacts)) return page === 0 ? 502 : { rows, pinsEnabled, truncated: true }
      if (page === 0) pinsEnabled = data.starsEnabled === true
      for (const raw of data.artifacts) {
        const row = parseRow(raw)
        if (row) rows.push(row)
      }
      pageToken = typeof data.next_page_token === 'string' && data.next_page_token ? data.next_page_token : undefined
      if (!pageToken) return { rows, pinsEnabled, truncated: false }
    }
    return { rows, pinsEnabled, truncated: true }
  }

  /** The older list: own artifacts and those shared with the login, at most 200. */
  private async frames(token: string): Promise<Lane | number> {
    const response = await this.request(token, 'GET', `/frames?limit=${PAGE_SIZE}`)
    if (!response.ok) return response.status
    const data = (await response.json().catch(() => null)) as { frames?: unknown; starsEnabled?: unknown } | null
    if (!data || !Array.isArray(data.frames)) return 502
    const rows = data.frames.map((raw) => parseRow(raw)).filter((row) => row !== null)
    return { rows, pinsEnabled: data.starsEnabled === true, truncated: data.frames.length >= PAGE_SIZE }
  }

  private async request(token: string, method: string, path: string, body?: unknown): Promise<Response> {
    const version = await this.clientVersion().catch(() => null)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': OAUTH_BETA,
      Accept: 'application/json, application/vnd.ant.frame-refusal+json',
      'User-Agent': this.userAgent,
      'X-Frame-CP': 'go',
      'X-Frame-Surface': 'code',
      'X-Frame-Platform': 'cli',
    }
    if (version) headers['X-Frame-Client-Version'] = version
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    return net.fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // The token goes to this address only, never on to another one.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  }
}

/** A row of either list as the app shows it; null for anything that isn't a page or document. */
export function parseArtifact(raw: unknown): Artifact | null {
  return parseRow(raw)?.artifact ?? null
}

function parseRow(raw: unknown): Row | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = text(r.id) ?? text(r.slug)
  if (!id || !ID_RE.test(id) || r.soft_deleted === true) return null
  // The older list has no kinds: its rows are pages.
  const kind = r.kind ?? 'page'
  if (kind !== 'page' && kind !== 'document') return null
  const mine = r.rel === 'mine'
  return {
    artifact: {
      id,
      url: `${ARTIFACT_URL}${id}`,
      title: cut(text(r.title)?.trim() || 'Ohne Titel', MAX_TITLE),
      description: nullable(text(r.description)?.trim(), MAX_DESCRIPTION),
      label: nullable(text(r.label)?.trim(), MAX_TITLE),
      kind,
      mine,
      renamable: typeof r.renamable === 'boolean' ? r.renamable : mine,
      ownerEmail: nullable(text(r.owner_email), MAX_TITLE),
      external: r.outside_organization === true,
      audience: AUDIENCES.find((audience) => audience === r.audience) ?? null,
      createdAt: isoDate(r.created_at),
      updatedAt: isoDate(r.updated_at) ?? publishedAt(r.live),
      lastViewedAt: isoDate(r.last_viewed_at),
      // Public ones count the views of everyone with the link.
      views: count(r.view_count) ?? count(r.public_view_count),
      pinned: r.starred === true,
    },
    thumbs: { light: thumbUrl(r.thumbImgURL), dark: thumbUrl(r.thumbDarkImgURL) },
  }
}

/** A thumbnail's link, only from the artifacts' own host. */
export function thumbUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.endsWith(THUMB_HOST) && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

/** The older list names the version on show as `<seconds>-<hash>`: when it was published. */
function publishedAt(live: unknown): string | null {
  const seconds = typeof live === 'string' ? /^(\d{9,11})-/.exec(live)?.[1] : undefined
  return seconds ? new Date(Number(seconds) * 1000).toISOString() : null
}

function listFailure(status: number, kind: string): { status: ArtifactListStatus; message: string } {
  if (status === 401) {
    return kind === 'token'
      ? { status: 'unavailable', message: 'Der Token ist ungültig oder wurde widerrufen.' }
      : { status: 'signed-out', message: 'Die Anmeldung ist abgelaufen. Starte eine Session oder melde den Account neu an.' }
  }
  if (status === 403 || status === 404) {
    return { status: 'unavailable', message: `Für diesen Login gibt claude.ai keine Artefakte heraus (HTTP ${status}).` }
  }
  if (status === 429) return { status: 'error', message: 'Zu viele Anfragen an claude.ai. Versuche es gleich noch einmal.' }
  return { status: 'error', message: `claude.ai antwortete mit HTTP ${status}.` }
}

function actionFailure(status: number, done: string): string {
  if (status === 401) return 'Die Anmeldung ist abgelaufen. Starte eine Session oder melde den Account neu an.'
  if (status === 403) return `Das Artefakt gehört nicht diesem Login und kann nicht ${done} werden.`
  if (status === 404) return 'Das Artefakt gibt es nicht mehr.'
  if (status === 429) return 'Zu viele Anfragen an claude.ai. Versuche es gleich noch einmal.'
  return `Das Artefakt konnte nicht ${done} werden (HTTP ${status}).`
}

function checkedId(id: string): string {
  if (!ID_RE.test(id)) throw new Error('Ungültige Artefakt-ID.')
  return encodeURIComponent(id)
}

/** When it was last looked at or changed, for the order of the list. */
function lastSeen(artifact: Artifact): number {
  return Date.parse(artifact.lastViewedAt ?? artifact.updatedAt ?? artifact.createdAt ?? '') || 0
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function cut(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function nullable(value: string | undefined, max: number): string | null {
  return value ? cut(value, max) : null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

/** An ISO string or a time in seconds or milliseconds, as ISO string. */
function isoDate(value: unknown): string | null {
  let ms = NaN
  if (typeof value === 'string') ms = Date.parse(value)
  else if (typeof value === 'number' && Number.isFinite(value)) ms = value < 1e12 ? value * 1000 : value
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
