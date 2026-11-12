import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, shell, type DownloadItem, type WebContents } from 'electron'
import { runsWhenOpened } from '@shared/executables'
import type { BrowserDownload, BrowserDownloadAction } from '@shared/types'
import { TypedEmitter } from '../lib/typed-emitter'
import { uniqueFileName } from './browser-policy'

/** The window hears of a download's progress at most this often (ms). */
const PROGRESS_MS = 250
/** Downloads the list keeps; older finished ones drop off. */
const MAX_DOWNLOADS = 50
/**
 * How many downloads a page may start in `BURST_MS`: enough for Claude fetching a list of files, the
 * rest of a page that starts them without end (to fill the disk) the browser refuses.
 */
const MAX_BURST = 20
const BURST_MS = 60_000

interface Entry {
  download: BrowserDownload
  /** Until the download is done. */
  item: DownloadItem | null
}

type Events = {
  /** The list changed (all of it, oldest first). */
  changed: [downloads: BrowserDownload[]]
  /** A page started a download. */
  started: [download: BrowserDownload]
  /** A download ended: completed, cancelled or failed. */
  finished: [download: BrowserDownload]
}

/**
 * What the browser downloads: like Chrome, right into the user's downloads folder, without asking
 * (a dialog would also stop Claude), under a name no file there has yet. One list for all browser
 * tabs, the pane a download came from shows it first.
 */
export class BrowserDownloads extends TypedEmitter<Events> {
  private readonly entries = new Map<string, Entry>()
  /** Paths of running downloads, so two of the same name don't get the same file. */
  private readonly reserved = new Set<string>()
  /** When each page (id of its contents) started its last downloads, and whether one was refused since. */
  private readonly bursts = new Map<number, { starts: number[]; refused: boolean }>()
  private emitTimer: NodeJS.Timeout | null = null

  constructor(private readonly now: () => number = Date.now) {
    super()
  }

  /**
   * From the browser profile's `will-download`: decides where the file goes, before Electron would
   * ask, or refuses it (`refuse`: the event's preventDefault) when the page started too many at once.
   * Null for a refused one the list already shows another of.
   */
  add(item: DownloadItem, contents: WebContents | null, refuse: () => void = () => item.cancel()): BrowserDownload | null {
    const contentsId = contents && !contents.isDestroyed() ? contents.id : 0
    if (!this.admit(contentsId)) {
      refuse()
      return this.addRefused(item, contentsId)
    }
    const folder = app.getPath('downloads')
    try {
      mkdirSync(folder, { recursive: true })
    } catch {
      // Electron reports the failure as an interrupted download.
    }
    const filename = uniqueFileName(item.getFilename(), (candidate) => {
      const path = join(folder, candidate)
      return this.reserved.has(path.toLowerCase()) || existsSync(path)
    })
    const path = join(folder, filename)
    item.setSavePath(path)
    this.reserved.add(path.toLowerCase())

    const download: BrowserDownload = {
      id: randomUUID(),
      contentsId,
      filename,
      path,
      url: item.getURL(),
      state: 'progressing',
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      startedAt: new Date().toISOString(),
      executable: runsWhenOpened(filename, process.platform),
      refused: false,
    }
    const entry: Entry = { download, item }
    this.entries.set(download.id, entry)
    this.trim()

    item.on('updated', (_event, state) => {
      download.state = state === 'interrupted' ? 'interrupted' : 'progressing'
      download.receivedBytes = item.getReceivedBytes()
      download.totalBytes = item.getTotalBytes()
      this.scheduleEmit()
    })
    item.once('done', (_event, state) => {
      download.state = state
      download.receivedBytes = item.getReceivedBytes()
      download.totalBytes = item.getTotalBytes() || download.receivedBytes
      entry.item = null
      this.reserved.delete(path.toLowerCase())
      this.emitNow()
      this.emit('finished', { ...download })
    })
    this.emitNow()
    this.emit('started', { ...download })
    return download
  }

  /** Whether the page may start another download now; counts it if so. */
  private admit(contentsId: number): boolean {
    const now = this.now()
    const burst = this.bursts.get(contentsId) ?? { starts: [], refused: false }
    burst.starts = burst.starts.filter((at) => now - at < BURST_MS)
    if (burst.starts.length === 0) burst.refused = false
    this.bursts.set(contentsId, burst)
    if (burst.starts.length >= MAX_BURST) return false
    burst.starts.push(now)
    return true
  }

  /** The first download of a burst the browser refused shows in the list; the others don't. */
  private addRefused(item: DownloadItem, contentsId: number): BrowserDownload | null {
    const burst = this.bursts.get(contentsId)!
    if (burst.refused) return null
    burst.refused = true
    const filename = uniqueFileName(item.getFilename(), () => false)
    const download: BrowserDownload = {
      id: randomUUID(),
      contentsId,
      filename,
      path: join(app.getPath('downloads'), filename),
      url: item.getURL(),
      state: 'cancelled',
      receivedBytes: 0,
      totalBytes: 0,
      startedAt: new Date().toISOString(),
      executable: runsWhenOpened(filename, process.platform),
      refused: true,
    }
    this.entries.set(download.id, { download, item: null })
    this.trim()
    this.emitNow()
    return download
  }

  list(): BrowserDownload[] {
    return [...this.entries.values()].map((e) => ({ ...e.download }))
  }

  async act(id: string, action: BrowserDownloadAction): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    const { download, item } = entry
    switch (action) {
      case 'open': {
        if (download.state !== 'completed') return
        if (!existsSync(download.path)) throw new Error('Die Datei gibt es nicht mehr.')
        const error = await shell.openPath(download.path)
        if (error) throw new Error(error)
        return
      }
      case 'show':
        // A file that was moved or deleted: its folder at least.
        if (existsSync(download.path)) shell.showItemInFolder(download.path)
        else await shell.openPath(dirname(download.path))
        return
      case 'cancel':
        if (item && download.state !== 'completed') item.cancel()
        return
      case 'remove':
        if (item && download.state !== 'completed') item.cancel()
        this.entries.delete(id)
        this.emitNow()
        return
    }
  }

  /** Takes the finished downloads off the list (the files stay). */
  clear(): void {
    for (const [id, entry] of this.entries) if (!entry.item) this.entries.delete(id)
    this.emitNow()
  }

  /** Keeps the list short: the oldest finished downloads go first. */
  private trim(): void {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= MAX_DOWNLOADS) return
      if (!entry.item) this.entries.delete(id)
    }
  }

  private scheduleEmit(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => this.emitNow(), PROGRESS_MS)
  }

  private emitNow(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    this.emit('changed', this.list())
  }
}

export const browserDownloads = new BrowserDownloads()
