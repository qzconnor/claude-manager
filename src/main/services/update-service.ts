import { app, BrowserWindow, Notification, net } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { splitNoteItems } from '@shared/release-notes'
import type { ReleaseNote, ReleaseReference, UpdateState } from '@shared/types'
import { linuxPackage } from '../lib/linux'
import { TypedEmitter } from '../lib/typed-emitter'
import { openAppWindows, revealWindow } from '../window/main-window'

/**
 * Updates come from the GitHub releases of the repository (published by semantic-release, see
 * `release.config.mjs`). The publish settings in `electron-builder.yml` tell electron-updater where.
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

/** A pull request through the issues endpoint, which answers for issues as well. */
interface GitHubIssue {
  number: number
  title: string
  body: string | null
  html_url: string
}

/** Links of the notes to a pull request or issue, e.g. `…/qzconnor/claude-manager/issues/17`. */
const REFERENCE_LINK = new RegExp(`https://github\\.com/${REPO}/(?:issues|pull)/(\\d+)`, 'g')

/**
 * Only an installed app can update itself. On Linux that is the AppImage (it replaces its own file)
 * and the deb and rpm packages (installed by the package manager, which asks for the password).
 */
function canUpdate(): boolean {
  return app.isPackaged && (process.platform !== 'linux' || linuxPackage() !== null)
}

export class UpdateService extends TypedEmitter<Events> {
  private state: UpdateState = {
    status: canUpdate() ? 'idle' : 'unsupported',
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
    if (!canUpdate()) return
    // Downloading is the user's choice; a downloaded update is also installed when quitting, except
    // for deb and rpm: the package manager asks for the password, which shouldn't come up on quitting.
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = linuxPackage() !== 'deb' && linuxPackage() !== 'rpm'
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
    autoUpdater.on('error', (error) => {
      // E.g. the password for the package manager was not given: the app keeps running.
      this.installingUpdate = false
      this.setState({ status: 'error', error: describeError(error) })
    })

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

  /** Title and description of a pull request (or issue) the notes link to – the details of a change. */
  async reference(number: number): Promise<ReleaseReference> {
    const response = await net.fetch(`https://api.github.com/repos/${REPO}/issues/${number}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': this.userAgent },
      cache: 'no-cache',
    })
    if (!response.ok) throw new Error(describeStatus(response))
    const issue = (await response.json()) as GitHubIssue
    return { number: issue.number, title: issue.title, body: issue.body?.trim() ?? '', url: issue.html_url }
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
      const win = openAppWindows()[0]
      if (!win) return
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
        // One line per change, also in releases whose title named several.
        html: splitNoteItems(release.body_html ?? ''),
        url: release.html_url,
        references: references(release.body_html ?? ''),
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
      const html = splitNoteItems(text('content'))
      return {
        // The id ends with the tag, e.g. `tag:github.com,2008:Repository/123456789/v1.2.3`.
        version: (text('id').split('/').pop() ?? '').replace(/^v/, ''),
        date: text('updated'),
        html,
        url: unescapeXml(/<link[^>]*href="([^"]*)"/.exec(entry)?.[1] ?? ''),
        references: references(html),
      }
    })
  }
}

/** Numbers of the pull requests (or issues) the notes link to, each once. */
function references(html: string): number[] {
  return [...new Set([...html.matchAll(REFERENCE_LINK)].map(([, number]) => Number(number)))]
}

/** The hourly limit without sign-in is 60 requests – the most likely reason for a refusal. */
function describeStatus(response: Response): string {
  const limited =
    response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
  if (limited) return 'GitHub nimmt gerade keine weiteren Anfragen an (Limit pro Stunde). Bitte später noch einmal versuchen.'
  if (response.status === 404) return 'Auf GitHub nicht gefunden.'
  return `GitHub antwortet mit Status ${response.status}.`
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
