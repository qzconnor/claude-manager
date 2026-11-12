import type { FileChangeNote, SessionFileChange } from '@shared/types'
import { shortenPath } from './format'

/**
 * A changed file as the list shows it: its name, and its folder relative to the session's folder
 * (from the home folder as `~` for one outside it).
 */
export function changePath(path: string, folder: string | null, home?: string | null): { name: string; dir: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = path.slice(cut + 1)
  const parent = cut > 0 ? path.slice(0, cut) : ''
  if (folder) {
    const windows = /^[a-z]:[\\/]|^\\\\/i.test(folder)
    const base = folder.replace(/[\\/]+$/, '')
    const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)
    if (same(parent, base)) return { name, dir: '' }
    const head = parent.slice(0, base.length)
    const sep = parent.charAt(base.length)
    if ((sep === '/' || sep === '\\') && same(head, base)) return { name, dir: parent.slice(base.length + 1) }
  }
  return { name, dir: shortenPath(parent, home) }
}

/** Lines added and removed by all `files`; `unknown`: some couldn't be counted. */
export function changeTotals(files: readonly SessionFileChange[]): { added: number; removed: number; unknown: boolean } {
  let added = 0
  let removed = 0
  let unknown = false
  for (const file of files) {
    if (file.added === null || file.removed === null) unknown = true
    else {
      added += file.added
      removed += file.removed
    }
  }
  return { added, removed, unknown }
}

const NOTES: Record<FileChangeNote, string> = {
  binary: 'Binärdatei',
  tooLarge: 'zu groß',
  unavailable: 'Stand nicht mehr da',
}

/** Why a change has no line counts, in words. */
export function noteLabel(note: FileChangeNote): string {
  return NOTES[note]
}
