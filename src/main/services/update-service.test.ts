import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { splitNoteItems } from '@shared/release-notes'

const fakes = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  class FakeNotification {
    static supported = true
    static created: FakeNotification[] = []
    static isSupported(): boolean {
      return FakeNotification.supported
    }

    readonly handlers = new Map<string, () => void>()
    shown = false

    constructor(readonly options: { title: string; body: string }) {
      FakeNotification.created.push(this)
    }

    on(event: string, handler: () => void): this {
      this.handlers.set(event, handler)
      return this
    }

    show(): void {
      this.shown = true
    }
  }

  const listeners = new Map<string, Listener[]>()
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: {} as unknown,
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return autoUpdater
    },
    checkForUpdates: vi.fn<() => Promise<unknown>>(),
    downloadUpdate: vi.fn<() => Promise<string[]>>(),
    quitAndInstall: vi.fn<(isSilent?: boolean, isForceRunAfter?: boolean) => void>(),
  }

  return {
    FakeNotification,
    listeners,
    autoUpdater,
    /** What electron-updater would emit. */
    emit(event: string, ...args: unknown[]): void {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    focusedWindow: { current: null as object | null },
    fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
    linuxPackage: vi.fn<() => 'appimage' | 'deb' | 'rpm' | null>(() => null),
    openAppWindows: vi.fn<() => object[]>(() => []),
    revealWindow: vi.fn<(win: object) => void>(),
  }
})

vi.mock('electron', () => ({
  app: fakes.app,
  BrowserWindow: { getFocusedWindow: () => fakes.focusedWindow.current },
  Notification: fakes.FakeNotification,
  net: { fetch: (url: string, init?: RequestInit) => fakes.fetch(url, init) },
}))
vi.mock('electron-updater', () => ({ autoUpdater: fakes.autoUpdater }))
vi.mock('../lib/linux', () => ({ linuxPackage: () => fakes.linuxPackage() }))
vi.mock('../window/main-window', () => ({
  openAppWindows: () => fakes.openAppWindows(),
  revealWindow: (win: object) => fakes.revealWindow(win),
}))

import type { UpdateState } from '@shared/types'
import { UpdateService } from './update-service'

const NOW = Date.parse('2026-11-12T10:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const { autoUpdater, emit, FakeNotification } = fakes

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...platform, value })
}

let service: UpdateService | null = null

/** A service whose `init` ran, as at the start of the app. */
function started(): UpdateService {
  service = new UpdateService('claude-manager-test')
  service.init()
  return service
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  // The platform decides whether the app can update itself: the same on every machine.
  setPlatform('win32')
  fakes.app.isPackaged = true
  fakes.listeners.clear()
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = {}
  autoUpdater.checkForUpdates.mockReset().mockResolvedValue(null)
  autoUpdater.downloadUpdate.mockReset().mockResolvedValue([])
  autoUpdater.quitAndInstall.mockReset()
  fakes.focusedWindow.current = null
  FakeNotification.supported = true
  FakeNotification.created = []
  fakes.fetch.mockReset()
  fakes.linuxPackage.mockReset().mockReturnValue(null)
  fakes.openAppWindows.mockReset().mockReturnValue([])
  fakes.revealWindow.mockReset()
})

afterEach(() => {
  service?.dispose()
  service = null
  Object.defineProperty(process, 'platform', platform)
  vi.useRealTimers()
})

describe('UpdateService support', () => {
  it('never checks in development, where the app is not packaged', async () => {
    fakes.app.isPackaged = false
    const updates = started()
    expect(updates.getState()).toMatchObject({ status: 'unsupported', current: '1.0.0' })
    expect(fakes.listeners.size).toBe(0)

    await vi.advanceTimersByTimeAsync(5 * HOUR)
    await updates.check()
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('updates on Linux only as AppImage or deb or rpm package, not as an unpacked build', () => {
    setPlatform('linux')
    expect(new UpdateService('ua').getState().status).toBe('unsupported')
    for (const kind of ['appimage', 'deb', 'rpm'] as const) {
      fakes.linuxPackage.mockReturnValue(kind)
      expect(new UpdateService('ua').getState().status).toBe('idle')
    }
  })

  it('leaves downloading to the user and installs a downloaded update on quitting, except for deb and rpm', () => {
    started()
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
    expect(autoUpdater.logger).toBeNull()

    setPlatform('linux')
    const expected = { appimage: true, deb: false, rpm: false } as const
    for (const kind of ['appimage', 'deb', 'rpm'] as const) {
      fakes.linuxPackage.mockReturnValue(kind)
      service?.dispose()
      started()
      expect(autoUpdater.autoInstallOnAppQuit, kind).toBe(expected[kind])
    }
  })
})

describe('UpdateService checks', () => {
  it('checks ten seconds after the start, then every four hours, and no more once disposed', async () => {
    const updates = started()
    await vi.advanceTimersByTimeAsync(10_000 - 1)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4 * HOUR - 10_000)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4 * HOUR)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3)

    updates.dispose()
    await vi.advanceTimersByTimeAsync(12 * HOUR)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('follows electron-updater from checking to an available update, its download and the finished download', () => {
    const updates = started()
    const changes: UpdateState[] = []
    updates.on('changed', (state) => changes.push(structuredClone(state)))

    emit('checking-for-update')
    expect(updates.getState()).toMatchObject({ status: 'checking', error: null })

    vi.setSystemTime(NOW + MINUTE)
    emit('update-available', { version: '1.2.0' })
    expect(updates.getState()).toMatchObject({ status: 'available', next: '1.2.0', checkedAt: NOW + MINUTE })

    emit('download-progress', { percent: 42.5 })
    expect(updates.getState()).toMatchObject({ status: 'downloading', progress: 42.5 })

    emit('update-downloaded', { version: '1.2.0' })
    expect(updates.getState()).toEqual({
      status: 'downloaded',
      current: '1.0.0',
      next: '1.2.0',
      progress: 100,
      checkedAt: NOW + MINUTE,
      error: null,
    })
    expect(changes.map((state) => state.status)).toEqual(['checking', 'available', 'downloading', 'downloaded'])
  })

  it('is up to date when no newer version is offered, and forgets an offer from before', () => {
    const updates = started()
    emit('update-available', { version: '1.2.0' })
    vi.setSystemTime(NOW + HOUR)
    emit('update-not-available', { version: '1.0.0' })
    expect(updates.getState()).toMatchObject({ status: 'up-to-date', next: null, checkedAt: NOW + HOUR })
  })

  it('does not check while a check or a download runs or an update waits to be installed', async () => {
    const updates = started()
    for (const event of ['checking-for-update', 'download-progress', 'update-downloaded']) {
      emit(event, { version: '1.2.0', percent: 10 })
      await updates.check()
    }
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checks again after an offer, an error or when up to date', async () => {
    const updates = started()
    emit('update-available', { version: '1.2.0' })
    await updates.check()
    emit('error', new Error('offline'))
    await updates.check()
    emit('update-not-available', { version: '1.0.0' })
    await updates.check()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('shows a failed check as an error with only the first line of the message', async () => {
    const updates = started()
    autoUpdater.checkForUpdates.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED\nHeaders: {…}\nlong dump'))
    await updates.check()
    expect(updates.getState()).toMatchObject({ status: 'error', error: 'net::ERR_INTERNET_DISCONNECTED', checkedAt: NOW })

    autoUpdater.checkForUpdates.mockRejectedValue(new Error('No published versions on GitHub\nmore'))
    await updates.check()
    expect(updates.getState().error).toBe('Auf GitHub ist noch keine Version veröffentlicht.')
  })

  it('shows errors electron-updater reports by itself, and clears them with the next check', () => {
    const updates = started()
    emit('error', new Error('sha512 checksum mismatch\nexpected …'))
    expect(updates.getState()).toMatchObject({ status: 'error', error: 'sha512 checksum mismatch' })
    emit('error', 'plain text error')
    expect(updates.getState().error).toBe('plain text error')

    emit('checking-for-update')
    expect(updates.getState()).toMatchObject({ status: 'checking', error: null })
  })
})

describe('UpdateService download and install', () => {
  it('downloads only an offered update, from zero percent', async () => {
    const updates = started()
    await updates.download()
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()

    emit('update-available', { version: '1.2.0' })
    emit('download-progress', { percent: 80 })
    emit('error', new Error('connection reset'))
    await updates.download()
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(updates.getState()).toMatchObject({ status: 'downloading', progress: 0, error: null, next: '1.2.0' })

    // A second click while it downloads does not start another download.
    await updates.download()
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not download after a failed check that offered no version', async () => {
    const updates = started()
    autoUpdater.checkForUpdates.mockRejectedValue(new Error('offline'))
    await updates.check()
    expect(updates.getState().status).toBe('error')
    await updates.download()
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('shows a failed download as an error, from which it can be downloaded again', async () => {
    const updates = started()
    emit('update-available', { version: '1.2.0' })
    autoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('ENOSPC: no space left on device\nstack'))
    await updates.download()
    expect(updates.getState()).toMatchObject({ status: 'error', error: 'ENOSPC: no space left on device', next: '1.2.0' })

    await updates.download()
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2)
    expect(updates.getState().status).toBe('downloading')
  })

  it('installs only a downloaded update, silently, and starts the new version afterwards', () => {
    const updates = started()
    emit('update-available', { version: '1.2.0' })
    updates.install()
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(updates.installing).toBe(false)

    emit('update-downloaded', { version: '1.2.0' })
    updates.install()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(updates.installing).toBe(true)
  })

  it('keeps running when installing fails, e.g. without the password for the package manager', () => {
    const updates = started()
    emit('update-downloaded', { version: '1.2.0' })
    updates.install()
    emit('error', new Error('pkexec: authentication dismissed'))
    expect(updates.installing).toBe(false)
    expect(updates.getState()).toMatchObject({ status: 'error', error: 'pkexec: authentication dismissed' })
  })
})

describe('UpdateService notification', () => {
  it('notifies about a new version once while no app window has the focus', () => {
    started()
    emit('update-available', { version: '1.2.0' })
    expect(FakeNotification.created).toHaveLength(1)
    expect(FakeNotification.created[0]!.options).toEqual({
      title: 'Update für Claude Manager',
      body: 'Version 1.2.0 ist verfügbar und lässt sich direkt in der App installieren.',
    })
    expect(FakeNotification.created[0]!.shown).toBe(true)

    // The next check offers the same version again.
    emit('update-available', { version: '1.2.0' })
    expect(FakeNotification.created).toHaveLength(1)
    emit('update-available', { version: '1.3.0' })
    expect(FakeNotification.created).toHaveLength(2)
  })

  it('does not notify while an app window has the focus or the system has no notifications', () => {
    started()
    fakes.focusedWindow.current = {}
    emit('update-available', { version: '1.2.0' })
    fakes.focusedWindow.current = null
    FakeNotification.supported = false
    emit('update-available', { version: '1.3.0' })
    expect(FakeNotification.created).toHaveLength(0)
  })

  it('shows the updates in the first app window when the notification is clicked', () => {
    const updates = started()
    const show = vi.fn()
    updates.on('show', show)
    emit('update-available', { version: '1.2.0' })
    const click = FakeNotification.created[0]!.handlers.get('click')!

    // All windows closed (the app lives in the tray): nothing to show.
    click()
    expect(fakes.revealWindow).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()

    const win = { id: 1 }
    fakes.openAppWindows.mockReturnValue([win, { id: 2 }])
    click()
    expect(fakes.revealWindow).toHaveBeenCalledWith(win)
    expect(show).toHaveBeenCalledTimes(1)
  })
})

const REPO_URL = 'https://github.com/qzconnor/claude-manager'

function apiRelease(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    published_at: '2026-11-01T08:00:00Z',
    body_html: `<ul><li>Change of ${tag} (<a href="${REPO_URL}/pull/12">#12</a>)</li></ul>`,
    html_url: `${REPO_URL}/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    ...extra,
  }
}

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/qzconnor/claude-manager/releases</id>
  <entry>
    <id>tag:github.com,2008:Repository/123456789/v1.2.0</id>
    <updated>2026-11-02T09:00:00Z</updated>
    <link rel="alternate" type="text/html" href="${REPO_URL}/releases/tag/v1.2.0?a=1&amp;b=2"/>
    <title>v1.2.0</title>
    <content type="html">&lt;ul&gt;&lt;li&gt;Tom &amp;amp; Jerry &#x2013; fixed (&lt;a href="${REPO_URL}/issues/7"&gt;#7&lt;/a&gt;, &lt;a href="${REPO_URL}/pull/9"&gt;#9&lt;/a&gt;, &lt;a href="${REPO_URL}/issues/7"&gt;#7&lt;/a&gt;)&lt;/li&gt;&lt;/ul&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/123456789/v1.1.0</id>
    <updated>2026-10-20T09:00:00Z</updated>
    <link rel="alternate" type="text/html" href="${REPO_URL}/releases/tag/v1.1.0"/>
    <content type="html">&lt;p&gt;First&lt;/p&gt;</content>
  </entry>
</feed>`

describe('UpdateService release notes', () => {
  it('lists the published releases of the API without drafts and prereleases, with the pull requests they link to', async () => {
    fakes.fetch.mockResolvedValue(
      json([
        apiRelease('v1.3.0-beta.1', { prerelease: true }),
        apiRelease('v1.2.1', { draft: true }),
        apiRelease('v1.2.0', {
          body_html: `<ul><li>One; two (<a href="${REPO_URL}/pull/12">#12</a>, <a href="${REPO_URL}/issues/3">#3</a>, <a href="${REPO_URL}/pull/12">#12</a>)</li></ul>`,
        }),
        apiRelease('v1.1.0', { published_at: null, body_html: undefined }),
      ]),
    )
    const notes = await new UpdateService('claude-manager-test').releases()

    expect(fakes.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fakes.fetch.mock.calls[0]!
    expect(url).toBe('https://api.github.com/repos/qzconnor/claude-manager/releases?per_page=30')
    expect(init?.headers).toMatchObject({ 'User-Agent': 'claude-manager-test' })
    expect(notes).toEqual([
      {
        version: '1.2.0',
        date: '2026-11-01T08:00:00Z',
        html: splitNoteItems(
          `<ul><li>One; two (<a href="${REPO_URL}/pull/12">#12</a>, <a href="${REPO_URL}/issues/3">#3</a>, <a href="${REPO_URL}/pull/12">#12</a>)</li></ul>`,
        ),
        url: `${REPO_URL}/releases/tag/v1.2.0`,
        references: [12, 3],
      },
      { version: '1.1.0', date: '', html: '', url: `${REPO_URL}/releases/tag/v1.1.0`, references: [] },
    ])
    // One line per change, also in releases whose title named several.
    expect(notes[0]!.html.match(/<li>/g)).toHaveLength(2)
  })

  it('reads the releases feed when the API refuses or lists no release', async () => {
    fakes.fetch.mockImplementation(async (url) =>
      url.endsWith('releases.atom') ? new Response(FEED, { status: 200 }) : json({ message: 'API rate limit exceeded' }, 403),
    )
    const notes = await new UpdateService('claude-manager-test').releases()
    expect(fakes.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/qzconnor/claude-manager/releases?per_page=30',
      `${REPO_URL}/releases.atom`,
    ])
    expect(notes).toEqual([
      {
        version: '1.2.0',
        date: '2026-11-02T09:00:00Z',
        html: `<ul><li>Tom &amp; Jerry – fixed (<a href="${REPO_URL}/issues/7">#7</a>, <a href="${REPO_URL}/pull/9">#9</a>, <a href="${REPO_URL}/issues/7">#7</a>)</li></ul>`,
        url: `${REPO_URL}/releases/tag/v1.2.0?a=1&b=2`,
        references: [7, 9],
      },
      { version: '1.1.0', date: '2026-10-20T09:00:00Z', html: '<p>First</p>', url: `${REPO_URL}/releases/tag/v1.1.0`, references: [] },
    ])

    fakes.fetch.mockReset()
    fakes.fetch.mockImplementation(async (url) => (url.endsWith('releases.atom') ? new Response(FEED, { status: 200 }) : json([])))
    vi.setSystemTime(NOW + HOUR)
    expect((await new UpdateService('claude-manager-test').releases()).map((note) => note.version)).toEqual(['1.2.0', '1.1.0'])
    expect(fakes.fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the releases for ten minutes, but never an empty answer', async () => {
    const updates = new UpdateService('claude-manager-test')
    fakes.fetch.mockImplementation(async (url) => (url.endsWith('releases.atom') ? new Response('<feed></feed>') : json([])))
    expect(await updates.releases()).toEqual([])
    expect(await updates.releases()).toEqual([])
    // Nothing kept: GitHub is asked again each time (API and feed).
    expect(fakes.fetch).toHaveBeenCalledTimes(4)

    fakes.fetch.mockReset()
    fakes.fetch.mockResolvedValue(json([apiRelease('v1.2.0')]))
    expect((await updates.releases()).map((note) => note.version)).toEqual(['1.2.0'])
    vi.setSystemTime(Date.now() + 10 * MINUTE - 1)
    expect((await updates.releases()).map((note) => note.version)).toEqual(['1.2.0'])
    expect(fakes.fetch).toHaveBeenCalledTimes(1)

    fakes.fetch.mockResolvedValue(json([apiRelease('v1.3.0'), apiRelease('v1.2.0')]))
    vi.setSystemTime(Date.now() + 1)
    expect((await updates.releases()).map((note) => note.version)).toEqual(['1.3.0', '1.2.0'])
    expect(fakes.fetch).toHaveBeenCalledTimes(2)
  })

  it('loads title and description of a pull request the notes link to', async () => {
    fakes.fetch.mockResolvedValue(json({ number: 12, title: 'Faster start', body: '  Details\n\n', html_url: `${REPO_URL}/pull/12` }))
    const updates = new UpdateService('claude-manager-test')
    expect(await updates.reference(12)).toEqual({ number: 12, title: 'Faster start', body: 'Details', url: `${REPO_URL}/pull/12` })
    expect(fakes.fetch.mock.calls[0]![0]).toBe('https://api.github.com/repos/qzconnor/claude-manager/issues/12')

    fakes.fetch.mockResolvedValue(json({ number: 13, title: 'No description', body: null, html_url: `${REPO_URL}/issues/13` }))
    expect((await updates.reference(13)).body).toBe('')
  })

  it('explains why GitHub refused the details of a pull request', async () => {
    const updates = new UpdateService('claude-manager-test')
    const limit = 'GitHub nimmt gerade keine weiteren Anfragen an (Limit pro Stunde). Bitte später noch einmal versuchen.'
    fakes.fetch.mockResolvedValue(json({}, 429))
    await expect(updates.reference(1)).rejects.toThrow(limit)
    fakes.fetch.mockResolvedValue(json({}, 403, { 'x-ratelimit-remaining': '0' }))
    await expect(updates.reference(1)).rejects.toThrow(limit)
    fakes.fetch.mockResolvedValue(json({}, 403, { 'x-ratelimit-remaining': '42' }))
    await expect(updates.reference(1)).rejects.toThrow('GitHub antwortet mit Status 403.')
    fakes.fetch.mockResolvedValue(json({}, 404))
    await expect(updates.reference(1)).rejects.toThrow('Auf GitHub nicht gefunden.')
    fakes.fetch.mockResolvedValue(json({}, 502))
    await expect(updates.reference(1)).rejects.toThrow('GitHub antwortet mit Status 502.')
  })
})
