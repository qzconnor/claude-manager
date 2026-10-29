import { app, BrowserWindow, Notification, net } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { ReleaseNote, UpdateState } from '@shared/types'
import { TypedEmitter } from '../lib/typed-emitter'
import { revealWindow } from '../window/main-window'

/**
 * Updates come from the GitHub releases of the repository (published by semantic-release, see
 * `.releaserc.json`). The publish settings in `electron-builder.yml` tell electron-updater where.
 */
const REPO = 'qzconnor/claude-manager'
const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60_000
const RELEASES_CACHE_MS = 10 * 60_000

type Events = {
  changed: [state: UpdateState]
  /** The system notification was clicked: the window should show the updates. */
  show: []
}

interface GitHubRelease {
  tag_name: string
  published_at: string | null
  body_html?: string
  html_url: string
  draft: boolean
  prerelease: boolean
}

export class UpdateService extends TypedEmitter<Events> {
  private state: UpdateState = {
    // Only an installed app can update itself.
    status: app.isPackaged ? 'idle' : 'unsupported',
    current: app.getVersion(),
    next: null,
    progress: 0,
    checkedAt: null,
    error: null,
  }
  private notifiedVersion: string | null = null
  private releasesCache: { at: number; notes: ReleaseNote[] } | null = null
  private timers: NodeJS.Timeout[] = []
  private installingUpdate = false

  constructor(private readonly userAgent: string) {
    super()
  }

  /** The app quits for the installer, so closing must not ask about running terminals again. */
  get installing(): boolean {
    return this.installingUpdate
  }

  getState(): UpdateState {
    return this.state
  }

  init(): void {
    if (!app.isPackaged) return
    // Downloading is the user's choice; a downloaded update is also installed when quitting.
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null

    autoUpdater.on('checking-for-update', () => this.setState({ status: 'checking', error: null }))
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.setState({ status: 'available', next: info.version, checkedAt: Date.now() })
      this.notify(info.version)
    })
    autoUpdater.on('update-not-available', () => this.setState({ status: 'up-to-date', next: null, checkedAt: Date.now() }))
    autoUpdater.on('download-progress', (progress: ProgressInfo) =>
      this.setState({ status: 'downloading', progress: progress.percent }),
    )
    autoUpdater.on('update-downloaded', (info: UpdateInfo) =>
      this.setState({ status: 'downloaded', next: info.version, progress: 100 }),
    )
    autoUpdater.on('error', (error) => this.setState({ status: 'error', error: describeError(error) }))

    this.timers.push(
      setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS),
      setInterval(() => void this.check(), CHECK_INTERVAL_MS),
    )
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  async check(): Promise<void> {
    if (['unsupported', 'checking', 'downloading', 'downloaded'].includes(this.state.status)) return
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.setState({ status: 'error', error: describeError(error), checkedAt: Date.now() })
    }
  }

  async download(): Promise<void> {
    if (!this.state.next || !['available', 'error'].includes(this.state.status)) return
    this.setState({ status: 'downloading', progress: 0, error: null })
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      this.setState({ status: 'error', error: describeError(error) })
    }
  }

  /**
   * Quits, runs the installer and starts the new version afterwards. Silently: the installer has
   * pages, but an update keeps the folder and mode of the installation, and only a silent install
   * starts the app again by itself. The page asks about running terminals before.
   */
  install(): void {
    if (this.state.status !== 'downloaded') return
    this.installingUpdate = true
    autoUpdater.quitAndInstall(true, true)
  }

  /** Published releases with their notes, newest first (cached for a few minutes). */
  async releases(): Promise<ReleaseNote[]> {
    const cache = this.releasesCache
    if (cache && Date.now() - cache.at < RELEASES_CACHE_MS) return cache.notes
    let notes: ReleaseNote[] = []
    try {
      notes = await this.releasesFromApi()
    } catch {
      // E.g. the API's hourly limit – the feed has none.
    }
    // The API sometimes lists no release for a while (an empty list); then the feed fills in.
    if (!notes.length) notes = await this.releasesFromFeed()
    // An empty answer is never kept, so the next look asks GitHub again.
    if (notes.length) this.releasesCache = { at: Date.now(), notes }
    return notes
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('changed', this.state)
  }

  /** System notification while the window is in the background – otherwise the page shows a hint. */
  private notify(version: string): void {
    if (this.notifiedVersion === version) return
    this.notifiedVersion = version
    if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return
    const notification = new Notification({
      title: 'Update für Claude Manager',
      body: `Version ${version} ist verfügbar und lässt sich direkt in der App installieren.`,
    })
    notification.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win || win.isDestroyed()) return
      revealWindow(win)
      this.emit('show')
    })
    notification.show()
  }

  /** Releases from the REST API: all of them, with the date of publication. */
  private async releasesFromApi(): Promise<ReleaseNote[]> {
    const response = await net.fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
      headers: { Accept: 'application/vnd.github.html+json', 'User-Agent': this.userAgent },
      // Always ask GitHub (cheap with the ETag) instead of answering from the HTTP cache.
      cache: 'no-cache',
    })
    if (!response.ok) throw new Error(`GitHub antwortet mit Status ${response.status}.`)
    const releases = (await response.json()) as GitHubRelease[]
    return releases
      .filter((release) => !release.draft && !release.prerelease)
      .map((release) => ({
        version: release.tag_name.replace(/^v/, ''),
        date: release.published_at ?? '',
        html: release.body_html ?? '',
        url: release.html_url,
      }))
  }

  /**
   * Releases from the Atom feed of the releases page (the one electron-updater reads too): the
   * latest 10, no rate limit. `updated` stands in for the date of publication.
   */
  private async releasesFromFeed(): Promise<ReleaseNote[]> {
    const response = await net.fetch(`https://github.com/${REPO}/releases.atom`, {
      headers: { 'User-Agent': this.userAgent },
      cache: 'no-cache',
    })
    if (!response.ok) throw new Error(`GitHub antwortet mit Status ${response.status}.`)
    const feed = await response.text()
    return [...feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => {
      const text = (tag: string) => unescapeXml(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry)?.[1] ?? '')
      return {
        // The id ends with the tag, e.g. `tag:github.com,2008:Repository/123456789/v1.2.3`.
        version: (text('id').split('/').pop() ?? '').replace(/^v/, ''),
        date: text('updated'),
        html: text('content'),
        url: unescapeXml(/<link[^>]*href="([^"]*)"/.exec(entry)?.[1] ?? ''),
      }
    })
  }
}

/** electron-updater appends long HTTP dumps to its errors – the first line is enough. */
function describeError(error: unknown): string {
  const line = (error instanceof Error ? error.message : String(error)).split('\n')[0]
  // Until the first release the releases feed is empty.
  return line.startsWith('No published versions') ? 'Auf GitHub ist noch keine Version veröffentlicht.' : line
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

/** `&lt;p&gt;` → `<p>` – in a single pass, so `&amp;lt;` correctly becomes `&lt;`. */
function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return XML_ENTITIES[entity.toLowerCase()] ?? match
    const hex = entity[1].toLowerCase() === 'x'
    return String.fromCodePoint(parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10))
  })
}
