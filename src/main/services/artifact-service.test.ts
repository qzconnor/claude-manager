import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountCredentials, AccountService } from './account-service'

const fetchMock = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>())
vi.mock('electron', () => ({ net: { fetch: fetchMock } }))
const renewMock = vi.hoisted(() => vi.fn())
vi.mock('./oauth-renewal', () => ({ renewOAuthLogin: renewMock }))

const { ArtifactService, parseArtifact, thumbUrl } = await import('./artifact-service')

const API = 'https://api.anthropic.com/api/frame'
const THUMB = 'https://abc.frame.claudeusercontent.com/_f/1/_thumb.img?__frame_t=t1'

let creds: AccountCredentials
const accounts = {
  credentials: vi.fn(() => creds),
  refresh: vi.fn(),
} as unknown as AccountService & { credentials: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const status = (code: number, headers: Record<string, string> = {}) => new Response(null, { status: code, headers })

/** Answers by method and path below /api/frame, in the order they are asked for. */
function route(answers: Record<string, (() => Response)[]>) {
  fetchMock.mockImplementation(async (url, init) => {
    const path = url.startsWith(API) ? url.slice(API.length).split('?')[0]! : url
    const queue = answers[`${init?.method ?? 'GET'} ${path}`]
    const next = queue?.shift()
    if (!next) throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
    return next()
  })
}

const calls = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url.replace(API, '')}`)

let waited: number[]
function service() {
  return new ArtifactService(accounts, 'claude-manager/1.0', async () => '2.1.322', async (ms) => {
    waited.push(ms)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  waited = []
  creds = {
    kind: 'oauth',
    accessToken: 'tok',
    accessTokenExpiresAt: Date.now() + 3_600_000,
    secret: null,
    paths: { configDir: 'C:/cfg', credentialsFile: 'C:/cfg/.credentials.json' },
    accountUuid: 'u1',
    loginKey: 'login:u1/',
  } as unknown as AccountCredentials
})

describe('ArtifactService.list', () => {
  it('falls back to the older list when the newer one is refused, as Claude Code does', async () => {
    route({
      'GET /artifacts': [() => new Response('artifacts listing serves session-credential callers only', { status: 403 })],
      'GET /frames': [
        () =>
          json({
            starsEnabled: true,
            frames: [
              { slug: 'old-1', title: 'Alt', rel: 'mine', live: '1789553634-54ef', last_viewed_at: '2026-10-01T10:00:00Z', renamable: true, thumbImgURL: THUMB },
              { slug: 'new-2', title: 'Neu', rel: 'shared', audience: 'public', last_viewed_at: '2026-11-01T10:00:00Z', removable: false, public_view_count: 3 },
              { slug: 'bad id/..', title: 'Kaputt' },
            ],
          }),
      ],
    })

    const list = await service().list('a1')

    expect(list.status).toBe('ok')
    expect(list.pinsEnabled).toBe(true)
    expect(list.artifacts.map((a) => a.id)).toEqual(['new-2', 'old-1'])
    expect(list.artifacts[1]).toMatchObject({ mine: true, renamable: true, updatedAt: '2026-09-16T10:13:54.000Z' })
    expect(list.artifacts[0]).toMatchObject({ mine: false, renamable: false, audience: 'public', views: 3 })
    expect(calls()).toEqual(['GET /artifacts?rel=all&kind=page%2Cdocument&sort=last_viewed&limit=200', 'GET /frames?limit=200'])
  })

  it('reads every page of the newer list and adds the shared ones once', async () => {
    route({
      'GET /artifacts': [
        () => json({ starsEnabled: true, next_page_token: 'p2', artifacts: [{ id: 'a', kind: 'page', rel: 'mine', last_viewed_at: '2026-11-03T00:00:00Z' }] }),
        () => json({ artifacts: [{ id: 'b', kind: 'document', rel: 'mine', last_viewed_at: '2026-11-01T00:00:00Z' }, { id: 'c', kind: 'code' }] }),
        () => json({ artifacts: [{ id: 'a', kind: 'page', rel: 'shared' }, { id: 'd', kind: 'page', rel: 'shared', last_viewed_at: '2026-11-02T00:00:00Z' }] }),
      ],
    })

    const list = await service().list('a1')

    expect(list.pinsEnabled).toBe(true)
    expect(list.artifacts.map((a) => [a.id, a.kind, a.mine])).toEqual([
      ['a', 'page', true],
      ['d', 'page', false],
      ['b', 'document', true],
    ])
    expect(calls()).toEqual([
      'GET /artifacts?rel=all&kind=page%2Cdocument&sort=last_viewed&limit=200',
      'GET /artifacts?rel=all&kind=page%2Cdocument&sort=last_viewed&limit=200&page_token=p2',
      'GET /artifacts?rel=shared&kind=page%2Cdocument&sort=last_viewed&limit=200',
    ])
  })

  it('sends the login token with the headers Claude Code sends, and follows no redirect', async () => {
    route({ 'GET /artifacts': [() => status(403)], 'GET /frames': [() => json({ frames: [] })] })

    await service().list('a1')

    const init = fetchMock.mock.calls[1]![1]!
    expect(init.redirect).toBe('error')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'anthropic-beta': 'oauth-2025-04-20',
      'X-Frame-Surface': 'code',
      'X-Frame-Platform': 'cli',
      'X-Frame-Client-Version': '2.1.322',
      'User-Agent': 'claude-manager/1.0',
    })
  })

  it('says why there are none: API key, signed out, refused', async () => {
    creds = { ...creds, kind: 'apiKey', accessToken: null }
    expect((await service().list('a1')).status).toBe('unavailable')
    expect(fetchMock).not.toHaveBeenCalled()

    creds = { ...creds, kind: 'oauth', accessToken: 'tok' }
    route({ 'GET /artifacts': [() => status(401)], 'GET /frames': [() => status(401)] })
    expect(await service().list('a1')).toMatchObject({ status: 'signed-out', artifacts: [] })

    creds = { ...creds, kind: 'token', secret: 'sk-setup' }
    route({ 'GET /artifacts': [() => status(401)], 'GET /frames': [() => status(401)] })
    expect((await service().list('a1')).status).toBe('unavailable')
    expect(fetchMock.mock.calls.at(-1)![1]!.headers).toMatchObject({ Authorization: 'Bearer sk-setup' })

    route({ 'GET /artifacts': [() => status(403)], 'GET /frames': [() => status(403)] })
    expect((await service().list('a1')).status).toBe('unavailable')
  })

  it('renews an expired login first and asks with the new token', async () => {
    creds = { ...creds, accessTokenExpiresAt: Date.now() - 1000 }
    renewMock.mockImplementation(async () => {
      creds = { ...creds, accessToken: 'tok2', accessTokenExpiresAt: Date.now() + 3_600_000 }
      return 'renewed'
    })
    route({ 'GET /artifacts': [() => status(403)], 'GET /frames': [() => json({ frames: [] })] })

    expect((await service().list('a1')).status).toBe('ok')
    expect(renewMock).toHaveBeenCalledWith('C:/cfg', 'C:/cfg/.credentials.json', 'claude-manager/1.0')
    expect(accounts.refresh).toHaveBeenCalled()
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: 'Bearer tok2' })
  })

  it('asks nothing with a login that can no longer be renewed', async () => {
    creds = { ...creds, accessTokenExpiresAt: Date.now() - 1000 }
    renewMock.mockResolvedValue('rejected')

    expect((await service().list('a1')).status).toBe('signed-out')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('ArtifactService: managing', () => {
  it('renames with the title cleaned up, and checks it first', async () => {
    route({ 'POST /retitle/x1': [() => status(200)] })

    await service().rename('a1', 'x1', '  Neuer \n Titel ')
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ title: 'Neuer Titel' })
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ 'Content-Type': 'application/json' })

    await expect(service().rename('a1', 'x1', '   ')).rejects.toThrow('leer')
    await expect(service().rename('a1', 'x1', 'T'.repeat(301))).rejects.toThrow('höchstens 300 Zeichen')
    await expect(service().rename('a1', '../x', 'T')).rejects.toThrow('Ungültige Artefakt-ID')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('deletes, waits once as long as the server asks, and takes an artifact gone already as deleted', async () => {
    route({ 'DELETE /x1': [() => status(503, { 'retry-after': '2' }), () => status(204)], 'DELETE /x2': [() => status(404)] })

    expect(await service().remove('a1', 'x1')).toBe('deleted')
    expect(waited).toEqual([2000])
    expect(await service().remove('a1', 'x2')).toBe('gone')
  })

  it('waits at most ten seconds and says why a delete failed', async () => {
    route({ 'DELETE /x1': [() => status(429, { 'retry-after': '120' }), () => status(429)], 'DELETE /x2': [() => status(403)] })

    await expect(service().remove('a1', 'x1')).rejects.toThrow('Zu viele Anfragen')
    expect(waited).toEqual([10_000])
    await expect(service().remove('a1', 'x2')).rejects.toThrow('gehört nicht diesem Login')
  })

  it('pins with POST and takes the pin off with DELETE', async () => {
    route({ 'POST /favorite/x1': [() => status(200)], 'DELETE /favorite/x1': [() => status(204)] })

    await service().setPinned('a1', 'x1', true)
    await service().setPinned('a1', 'x1', false)
    expect(calls()).toEqual(['POST /favorite/x1', 'DELETE /favorite/x1'])
  })
})

describe('ArtifactService.thumbnail', () => {
  it('loads only the thumbnails of the last list, without the login token', async () => {
    route({
      'GET /artifacts': [() => status(403)],
      'GET /frames': [() => json({ frames: [{ slug: 'x1', rel: 'mine', thumbImgURL: THUMB }, { slug: 'x2', rel: 'mine' }] })],
      [`GET ${THUMB}`]: [() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })],
    })
    const artifacts = service()

    expect(await artifacts.thumbnail('a1', 'x1', false)).toBeNull()
    await artifacts.list('a1')
    expect(await artifacts.thumbnail('a1', 'x1', true)).toBe('data:image/png;base64,AQID')
    expect(await artifacts.thumbnail('a1', 'x2', false)).toBeNull()
    expect(await artifacts.thumbnail('a2', 'x1', false)).toBeNull()

    const init = fetchMock.mock.calls.at(-1)![1]!
    expect(init.headers).not.toHaveProperty('Authorization')
    expect(init.redirect).toBe('error')
  })

  it('takes the dark one for a dark theme where there is one', async () => {
    const dark = THUMB.replace('_thumb', '_thumb_dark')
    route({
      'GET /artifacts': [() => status(403)],
      'GET /frames': [() => json({ frames: [{ slug: 'x1', rel: 'mine', thumbImgURL: THUMB, thumbDarkImgURL: dark }] })],
      [`GET ${dark}`]: [() => new Response(new Uint8Array([9]), { headers: { 'content-type': 'image/webp' } })],
      [`GET ${THUMB}`]: [() => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/webp' } })],
    })
    const artifacts = service()
    await artifacts.list('a1')

    expect(await artifacts.thumbnail('a1', 'x1', true)).toBe('data:image/webp;base64,CQ==')
    expect(await artifacts.thumbnail('a1', 'x1', false)).toBe('data:image/webp;base64,AQ==')
  })

  it('takes nothing but pictures, and none over 2 MB', async () => {
    route({
      'GET /artifacts': [() => status(403)],
      'GET /frames': [() => json({ frames: [{ slug: 'x1', rel: 'mine', thumbImgURL: THUMB }] })],
      [`GET ${THUMB}`]: [
        () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
        // Without a length up front: counted once it is there.
        () => new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
      ],
    })
    const artifacts = service()
    await artifacts.list('a1')

    expect(await artifacts.thumbnail('a1', 'x1', false)).toBeNull()
    expect(await artifacts.thumbnail('a1', 'x1', false)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

describe('thumbUrl', () => {
  it('accepts only https links of the artifacts host', () => {
    expect(thumbUrl(THUMB)).toBe(THUMB)
    expect(thumbUrl('http://abc.frame.claudeusercontent.com/x')).toBeNull()
    expect(thumbUrl('https://frame.claudeusercontent.com.evil.example/x')).toBeNull()
    expect(thumbUrl('https://user:pw@abc.frame.claudeusercontent.com/x')).toBeNull()
    expect(thumbUrl('nicht einmal ein Link')).toBeNull()
    expect(thumbUrl(42)).toBeNull()
  })
})

describe('parseArtifact', () => {
  it('leaves out deleted ones and other kinds, and caps what is shown', () => {
    expect(parseArtifact({ id: 'x', soft_deleted: true })).toBeNull()
    expect(parseArtifact({ id: 'x', kind: 'code' })).toBeNull()
    expect(parseArtifact({ title: 'ohne ID' })).toBeNull()
    const artifact = parseArtifact({ id: 'x', title: 'T'.repeat(500), audience: 'alle', view_count: -1, created_at: 1_790_000_000 })!
    expect(artifact.title).toHaveLength(300)
    expect(artifact.audience).toBeNull()
    expect(artifact.views).toBeNull()
    expect(artifact.createdAt).toBe('2026-09-21T14:13:20.000Z')
    expect(artifact.url).toBe('https://claude.ai/code/artifact/x')
  })
})
