import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DownloadItem, WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ app: { getPath: (_name: string): string => '' }, shell: {} }))
vi.mock('electron', () => electron)

const { BrowserDownloads } = await import('./browser-downloads')

let folder: string

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'cm-downloads-'))
  electron.app.getPath = () => folder
})

afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

function item(name: string): DownloadItem & { cancelled: boolean } {
  const fake = {
    cancelled: false,
    getFilename: () => name,
    getURL: () => `https://example.test/${name}`,
    getReceivedBytes: () => 0,
    getTotalBytes: () => 0,
    setSavePath: () => undefined,
    on: () => fake,
    once: () => fake,
    cancel: () => {
      fake.cancelled = true
    },
  }
  return fake as unknown as DownloadItem & { cancelled: boolean }
}

const page = (id: number) => ({ id, isDestroyed: () => false }) as unknown as WebContents

describe('BrowserDownloads', () => {
  it('marks downloads that opening would run', () => {
    const downloads = new BrowserDownloads()
    expect(downloads.add(item('report.pdf'), page(1))!.executable).toBe(false)
    expect(downloads.add(item(process.platform === 'win32' ? 'setup.exe' : 'install.sh'), page(1))!.executable).toBe(true)
  })

  it('refuses what a page starts beyond its burst, and lists only the first refused one', () => {
    let now = 0
    const downloads = new BrowserDownloads(() => now)
    for (let i = 0; i < 20; i++) expect(downloads.add(item(`f${i}.txt`), page(1))!.refused).toBe(false)
    let refused = 0
    const first = downloads.add(item('more.txt'), page(1), () => refused++)
    expect(first).toMatchObject({ refused: true, state: 'cancelled', filename: 'more.txt' })
    expect(downloads.add(item('even-more.txt'), page(1), () => refused++)).toBeNull()
    expect(refused).toBe(2)
    // Another page has its own burst.
    expect(downloads.add(item('other.txt'), page(2))!.refused).toBe(false)
    // A minute later the page may download again.
    now = 60_000
    expect(downloads.add(item('later.txt'), page(1))!.refused).toBe(false)
  })
})
