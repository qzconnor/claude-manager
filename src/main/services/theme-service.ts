import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import {
  customThemeId,
  customThemeStem,
  MAX_THEME_FILE_BYTES,
  parseThemeFile,
  themeContent,
  themeSlug,
  themeToFile,
  ThemeFileError,
  uniqueSlug,
  uniqueThemeName,
} from '@shared/themes/file'
import { THEMES } from '@shared/themes/builtin'
import type { CustomThemeEntry, ThemeContent, ThemeImportResult } from '@shared/themes/types'
import { writeJsonAtomic } from '../lib/json-file'
import { TypedEmitter } from '../lib/typed-emitter'

type Events = {
  /** A theme file came, went or changed, also by hand (an editor, Explorer): `list` has news. */
  changed: []
  /**
   * The app wrote this theme (the window or Claude's theme tools). Comes at once, so the window knows
   * the theme before a setting that picks it; `changed` follows from the folder's watcher.
   */
  saved: [entry: CustomThemeEntry]
}

/** Editors save in bursts (a temp file, then a rename): one look once it is quiet. */
const CHANGE_DELAY_MS = 250
/** Changes that go on and on (a big copy) still show after this long. */
const MAX_CHANGE_DELAY_MS = 1000
/** The folder itself was deleted or can't be watched: tried again after this long. */
const REWATCH_DELAY_MS = 2000

/** Moves a file to the recycle bin (Electron's `shell.trashItem`); deletes it where there is none. */
export type Trash = (path: string) => Promise<void>

/**
 * The user's own themes: one JSON file each in the folder `themes` of the app's data. The built-in
 * themes aren't files. The folder is watched, so themes copied into it, edited in another program
 * or deleted there show at once. A theme's id is `custom:` and its file name.
 */
export class ThemeService extends TypedEmitter<Events> {
  readonly dir: string
  private watcher: FSWatcher | null = null
  private changeTimer: ReturnType<typeof setTimeout> | null = null
  private rewatchTimer: ReturnType<typeof setTimeout> | null = null
  /** When the first change since the last `changed` came. */
  private pendingSince: number | null = null
  private disposed = false

  constructor(
    userDataDir: string,
    private readonly trash: Trash = (path) => rm(path, { force: true }),
  ) {
    super()
    this.dir = join(userDataDir, 'themes')
  }

  init(): void {
    this.watchFolder()
  }

  dispose(): void {
    this.disposed = true
    this.watcher?.close()
    this.watcher = null
    if (this.changeTimer) clearTimeout(this.changeTimer)
    if (this.rewatchTimer) clearTimeout(this.rewatchTimer)
  }

  /** Every `.json` file in the folder, sorted by name; files that can't be used with the reason. */
  async list(): Promise<CustomThemeEntry[]> {
    const stems = await this.stems()
    const entries = await Promise.all(stems.map((stem) => this.read(stem)))
    return entries.sort((a, b) => (a.theme?.name ?? a.id).localeCompare(b.theme?.name ?? b.id, 'de', { sensitivity: 'base' }))
  }

  /** A new file for the theme, named after it; a name another theme has gets a number. */
  async create(theme: ThemeContent): Promise<CustomThemeEntry> {
    const entries = await this.list()
    const name = uniqueThemeName(theme.name, takenNames(entries))
    const stem = uniqueSlug(themeSlug(name), await this.stems())
    return this.write(stem, { ...themeContent(theme), name })
  }

  /**
   * Saves the theme of `id` (again, if its file was deleted meanwhile). With a new name the file
   * gets a new name too; resolves to the theme with its id, maybe a new one.
   */
  async save(id: string, theme: ThemeContent): Promise<CustomThemeEntry> {
    const stem = this.requireStem(id)
    const content = themeContent({ ...theme, name: theme.name.trim() || 'Eigenes Theme' })
    // Only a new name renames the file: one named by hand (e.g. copied in) keeps its name otherwise.
    const saved = (await this.read(stem)).theme
    const wanted = themeSlug(content.name)
    if (!saved || saved.name === content.name || wanted === themeSlug(stem)) return this.write(stem, content)
    const others = (await this.stems()).filter((s) => s.toLowerCase() !== stem.toLowerCase())
    const next = uniqueSlug(wanted, others)
    const entry = await this.write(next, content)
    if (next.toLowerCase() !== stem.toLowerCase()) await rm(this.fileOf(stem), { force: true })
    return entry
  }

  /** Moves the theme's file to the recycle bin. */
  async remove(id: string): Promise<void> {
    await this.trash(this.fileOf(this.requireStem(id)))
  }

  /** The theme's file as it is, e.g. to give it to someone. */
  async exportTo(id: string, target: string): Promise<void> {
    const entry = await this.read(this.requireStem(id))
    if (!entry.theme) throw new Error(entry.error ?? 'Das Theme lässt sich nicht lesen.')
    await writeJsonAtomic(target, themeToFile(entry.theme))
  }

  /** Takes over themes from files elsewhere, each as a new theme; files that can't be read are named. */
  async importFrom(files: readonly string[]): Promise<ThemeImportResult> {
    const result: ThemeImportResult = { imported: [], failed: [] }
    for (const file of files) {
      try {
        const theme = parseThemeFile(await readThemeJson(file), basename(file, extname(file)))
        result.imported.push(await this.create(theme))
      } catch (error) {
        result.failed.push({ file, error: errorText(error) })
      }
    }
    return result
  }

  /** The file of a theme; throws for an id that isn't one of a file in the folder. */
  fileOf(stemOrId: string): string {
    const stem = customThemeStem(stemOrId) ?? stemOrId
    if (!stem || /[\\/]/.test(stem) || stem === '.' || stem === '..') throw new Error('Ungültiges Theme.')
    return join(this.dir, `${stem}.json`)
  }

  private requireStem(id: string): string {
    const stem = customThemeStem(id)
    if (!stem) throw new Error('Eingebaute Themes lassen sich nicht ändern, nur kopieren.')
    this.fileOf(stem)
    return stem
  }

  private async stems(): Promise<string[]> {
    const names = await readdir(this.dir).catch(() => [] as string[])
    return names.filter((name) => extname(name).toLowerCase() === '.json').map((name) => name.slice(0, -'.json'.length))
  }

  private async read(stem: string): Promise<CustomThemeEntry> {
    const file = this.fileOf(stem)
    const id = customThemeId(stem)
    try {
      const theme = parseThemeFile(await readThemeJson(file), stem)
      return { id, file, theme: { ...theme, id }, error: null }
    } catch (error) {
      return { id, file, theme: null, error: errorText(error) }
    }
  }

  private async write(stem: string, theme: ThemeContent): Promise<CustomThemeEntry> {
    await mkdir(this.dir, { recursive: true })
    const file = this.fileOf(stem)
    await writeJsonAtomic(file, themeToFile(theme))
    const id = customThemeId(stem)
    const entry: CustomThemeEntry = { id, file, theme: { ...theme, id }, error: null }
    this.emit('saved', entry)
    return entry
  }

  /** Watches the folder; made anew when it is gone (deleted by hand), and watched again. */
  private watchFolder(): void {
    if (this.disposed) return
    const old = this.watcher
    this.watcher = null
    old?.close()
    try {
      mkdirSync(this.dir, { recursive: true })
      const watcher = watch(this.dir, (_event, filename) => {
        // Windows reports the deleted folder itself (its whole path), over and over: watched anew.
        if (filename && /[\\/]/.test(String(filename))) this.rewatch()
        else this.scheduleChanged()
      })
      watcher.on('error', () => this.rewatch())
      // Deleting the folder ends the watcher on some systems without an error.
      watcher.on('close', () => {
        if (this.watcher === watcher) this.rewatch()
      })
      this.watcher = watcher
    } catch (error) {
      console.error('[themes] folder could not be watched', error)
      this.rewatch()
    }
  }

  /** Stops watching at once; after a moment the folder is made again if need be and watched. */
  private rewatch(): void {
    if (this.disposed || this.rewatchTimer) return
    const old = this.watcher
    this.watcher = null
    old?.close()
    this.rewatchTimer = setTimeout(() => {
      this.rewatchTimer = null
      this.watchFolder()
      this.scheduleChanged()
    }, REWATCH_DELAY_MS)
  }

  /** One `changed` once it is quiet, at the latest MAX_CHANGE_DELAY_MS after the first change. */
  private scheduleChanged(): void {
    const now = Date.now()
    this.pendingSince ??= now
    if (this.changeTimer) clearTimeout(this.changeTimer)
    const wait = Math.max(0, Math.min(CHANGE_DELAY_MS, this.pendingSince + MAX_CHANGE_DELAY_MS - now))
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      this.pendingSince = null
      // Gone without the watcher saying so (Linux ends it quietly): made again and watched.
      void stat(this.dir).then(
        (info) => {
          if (!info.isDirectory()) this.rewatch()
        },
        () => this.rewatch(),
      )
      this.emit('changed')
    }, wait)
  }
}

/** The names of the built-in themes and those of the files. */
function takenNames(entries: readonly CustomThemeEntry[]): string[] {
  return [...THEMES.map((t) => t.name), ...entries.flatMap((e) => (e.theme ? [e.theme.name] : []))]
}

async function readThemeJson(file: string): Promise<unknown> {
  const info = await stat(file)
  if (!info.isFile()) throw new ThemeFileError('Das ist keine Datei.')
  if (info.size > MAX_THEME_FILE_BYTES) throw new ThemeFileError('Die Datei ist zu groß für ein Theme.')
  const text = await readFile(file, 'utf8')
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (error) {
    throw new ThemeFileError(`Kein gültiges JSON: ${(error as Error).message}`)
  }
}

function errorText(error: unknown): string {
  if (error instanceof ThemeFileError) return error.message
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return 'Die Datei gibt es nicht mehr.'
  if (code === 'EACCES' || code === 'EPERM') return 'Kein Zugriff auf die Datei.'
  return error instanceof Error ? error.message : String(error)
}

