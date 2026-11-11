import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { folderKey, inFolder, movedPath, TRAILING_SEPARATORS, windowsPath } from '@shared/folders'
import type { Workspace, WorkspaceCreateInput } from '@shared/types'
import { WORKSPACE_PROMPT_FILE, workspaceNameError, workspaceOf, workspacesContaining } from '@shared/workspaces'
import { readJsonGuardedSync, writeJsonAtomic } from '../lib/json-file'
import { TypedEmitter } from '../lib/typed-emitter'

/** The prompt of one workspace a session lies in. */
export interface WorkspacePrompt {
  path: string
  name: string
  text: string
}

interface WorkspaceFile {
  folders: string[]
  /**
   * The workspaces and the folders in them as last seen, with their identity on disk (device and
   * file id): a folder that is gone while one with its identity came is the same one, moved.
   */
  seen?: [path: string, id: string][]
}

/** A folder seen in or as a workspace. `id` is empty where the disk gives folders none (some network drives). */
interface SeenFolder {
  path: string
  id: string
}

/** The folder `from` was moved to `to` outside the app; awaited before the list is read again. */
export type MoveFollower = (from: string, to: string) => Promise<void>

/** Where `move` put the folder. */
export interface FolderMove {
  path: string
  /** Moved to another drive: copied, but not all of the old folder could be deleted. */
  leftover: boolean
}

type Events = {
  /** Workspaces came or went, or the folders in one of them changed: `list` has news. */
  changed: []
}

/** A longer prompt is cut: it goes with every request of the session. */
const MAX_PROMPT_LENGTH = 100_000
/** Changes in the folders come in bursts (a checkout, an unpacked archive). */
const CHANGE_DELAY_MS = 300

/**
 * The workspaces: folders the user made one of (a list in the app's data folder, `workspaces.json`),
 * each with its prompt in `cm_prompts.md` in the folder. Only listed folders count, so a
 * `cm_prompts.md` that comes with a cloned repository never gets into a session's system prompt.
 */
export class WorkspaceService extends TypedEmitter<Events> {
  private readonly file: string
  private folders: string[] = []
  private readonly watchers = new Map<string, FSWatcher>()
  private changeTimer: ReturnType<typeof setTimeout> | null = null
  /** By `folderKey`. */
  private seen = new Map<string, SeenFolder>()
  private follower: MoveFollower | null = null
  /** Looking for moved folders and moving one, one after the other. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(userDataDir: string) {
    super()
    this.file = join(userDataDir, 'workspaces.json')
  }

  init(): void {
    const data = readJsonGuardedSync<Partial<WorkspaceFile>>(this.file)
    const folders = Array.isArray(data?.folders) ? data.folders : []
    this.folders = unique(folders.filter((f): f is string => typeof f === 'string' && isAbsolute(f)).map(clean))
    const seen = Array.isArray(data?.seen) ? data.seen : []
    for (const entry of seen) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string' || !isAbsolute(entry[0])) continue
      this.seen.set(folderKey(entry[0]), { path: entry[0], id: entry[1] })
    }
    this.syncWatchers()
  }

  /**
   * Folders moved outside the app (in Explorer, also while the app was closed) are followed with
   * `follower`, e.g. their sessions go along. Looks for such moves right away.
   */
  follow(follower: MoveFollower): void {
    this.follower = follower
    void this.detectMoves()
  }

  /**
   * Compares the folders in and of the workspaces with how they were last seen: one that is gone,
   * while one with its identity came, was moved there. A moved workspace keeps being one, at its new
   * place; then the follower runs for each move.
   */
  detectMoves(): Promise<void> {
    return this.serially(() => this.detectNow())
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    if (this.changeTimer) clearTimeout(this.changeTimer)
  }

  /** The folders of the workspaces, in the order the session list shows them (new ones last). */
  paths(): string[] {
    return [...this.folders]
  }

  /** Also follows folders moved meanwhile, so the list shows them where they are. */
  async list(): Promise<Workspace[]> {
    await this.detectMoves()
    return Promise.all(this.folders.map((path) => this.describe(path)))
  }

  /**
   * Moves the folder `from` into the folder `into`, keeping its name; workspaces in it move along.
   * To another drive it is copied and then deleted. The caller moves the sessions along.
   */
  async move(from: string, into: string): Promise<FolderMove> {
    const source = clean(from)
    const parent = clean(into)
    const name = basename(source)
    const info = await stat(source).catch(() => null)
    if (!info?.isDirectory()) throw new Error(`Den Ordner „${source}“ gibt es nicht.`)
    if (!(await stat(parent).catch(() => null))?.isDirectory()) throw new Error(`Den Ordner „${parent}“ gibt es nicht.`)
    if (inFolder(parent, source)) throw new Error(`„${name}“ kann nicht in sich selbst verschoben werden.`)
    const target = join(parent, name)
    if (folderKey(target) === folderKey(source)) throw new Error(`„${name}“ liegt schon in „${basename(parent) || parent}“.`)
    if (existsSync(target)) throw new Error(`In „${basename(parent) || parent}“ gibt es schon einen Ordner „${name}“.`)

    // In the queue, so looking for moves doesn't take this one for one made outside the app.
    const renamed = await this.serially(async () => {
      this.release(source)
      try {
        await rename(source, target)
        await this.moved(source, target)
        return true
      } catch (error) {
        this.syncWatchers()
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EXDEV') return false
        if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
          throw new Error(`„${name}“ ist gerade in Benutzung, etwa von einer Shell, einem Editor oder dem Explorer. Schließe sie und versuche es noch einmal.`)
        }
        throw error
      }
    })
    if (renamed) return { path: target, leftover: false }

    // Another drive: copied, it is a new folder there, which looking for moves can't mistake for the old one.
    try {
      await cp(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    let leftover = false
    try {
      this.release(source)
      await rm(source, { recursive: true, force: true, maxRetries: 2 })
    } catch (error) {
      console.warn(`[workspaces] the old folder ${source} could not be deleted completely`, error)
      leftover = existsSync(source)
    }
    await this.serially(() => this.moved(source, target))
    return { path: target, leftover }
  }

  /**
   * Makes the folder `parent\name` with a `cm_prompts.md` and lists it as a workspace. Folders that are
   * there already (also `name` itself) are used as they are; a `cm_prompts.md` in it keeps its text
   * unless `prompt` brings one.
   */
  async create(input: WorkspaceCreateInput): Promise<Workspace> {
    const error = workspaceNameError(input.name)
    if (error) throw new Error(error)
    if (!isAbsolute(input.parent)) throw new Error('Wähle den Ordner, in dem der Workspace entstehen soll.')
    const path = join(clean(input.parent), input.name.trim())
    const info = await stat(path).catch(() => null)
    if (info && !info.isDirectory()) throw new Error(`„${path}“ ist eine Datei, kein Ordner.`)
    if (!info) await mkdir(path, { recursive: true })
    const prompt = normalizePrompt(input.prompt)
    const file = join(path, WORKSPACE_PROMPT_FILE)
    if (prompt || !existsSync(file)) await writeFile(file, prompt, 'utf8')
    return this.add(path)
  }

  /**
   * Makes an existing folder a workspace. `prompt` replaces the text of its `cm_prompts.md`; null
   * keeps one that is there, or writes an empty one.
   */
  async adopt(folder: string, prompt: string | null): Promise<Workspace> {
    const path = clean(folder)
    const info = await stat(path).catch(() => null)
    if (!info?.isDirectory()) throw new Error(`Den Ordner „${path}“ gibt es nicht.`)
    const file = join(path, WORKSPACE_PROMPT_FILE)
    if (prompt !== null) await writeFile(file, normalizePrompt(prompt), 'utf8')
    else if (!existsSync(file)) await writeFile(file, '', 'utf8')
    return this.add(path)
  }

  /** Makes the folder `name` in the workspace: a new project, to start sessions in. Returns its path. */
  async createProject(workspace: string, name: string): Promise<string> {
    const root = this.require(workspace)
    const error = workspaceNameError(name, 'Projekt')
    if (error) throw new Error(error)
    const path = join(root, name.trim())
    if (existsSync(path)) throw new Error(`„${name.trim()}“ gibt es in „${basename(root) || root}“ schon.`)
    await mkdir(path)
    this.changedSoon()
    return path
  }

  /** Takes the folder off the list; the folder and its `cm_prompts.md` stay. */
  async remove(folder: string): Promise<void> {
    const key = folderKey(folder)
    const next = this.folders.filter((f) => folderKey(f) !== key)
    if (next.length === this.folders.length) return
    this.folders = next
    await this.save()
  }

  /** Puts the workspaces in the order of `paths`, as dragged in the list; ones it leaves out go after them. */
  async reorder(paths: readonly string[]): Promise<void> {
    const byKey = new Map(this.folders.map((f) => [folderKey(f), f]))
    const ordered = unique(paths.map((p) => byKey.get(folderKey(p))).filter((p): p is string => p !== undefined))
    const placed = new Set(ordered)
    const next = [...ordered, ...this.folders.filter((f) => !placed.has(f))]
    if (next.every((f, i) => f === this.folders[i])) return
    this.folders = next
    await this.save()
  }

  /** The text of the folder's `cm_prompts.md`, empty without one; also of a folder about to become a workspace. */
  async readPrompt(folder: string): Promise<string> {
    return readFile(join(clean(folder), WORKSPACE_PROMPT_FILE), 'utf8').then(stripBom, () => '')
  }

  async writePrompt(folder: string, text: string): Promise<void> {
    const path = this.require(folder)
    await writeFile(join(path, WORKSPACE_PROMPT_FILE), normalizePrompt(text), 'utf8')
    this.changedSoon()
  }

  /**
   * The prompts of the workspaces `cwd` lies in, the outermost first, for a session that starts
   * there. Read as it starts, so a change counts from the next session on. Without text, none.
   */
  promptsFor(cwd: string): WorkspacePrompt[] {
    const prompts: WorkspacePrompt[] = []
    for (const path of workspacesContaining(cwd, this.folders)) {
      let text = ''
      try {
        text = stripBom(readFileSync(join(path, WORKSPACE_PROMPT_FILE), 'utf8')).trim()
      } catch {
        // No file, no prompt.
      }
      if (text) prompts.push({ path, name: basename(path) || path, text: text.slice(0, MAX_PROMPT_LENGTH) })
    }
    return prompts
  }

  private require(folder: string): string {
    const key = folderKey(folder)
    const path = this.folders.find((f) => folderKey(f) === key)
    if (!path) throw new Error(`„${folder}“ ist kein Workspace.`)
    return path
  }

  /** Lists the folder: last, or in a workspace right below it and the others in it. */
  private async add(path: string): Promise<Workspace> {
    const key = folderKey(path)
    if (!this.folders.some((f) => folderKey(f) === key)) {
      this.folders = placeIn(this.folders, path)
      await this.save()
    } else {
      this.changedSoon()
    }
    return this.describe(path)
  }

  private async save(): Promise<void> {
    this.syncWatchers()
    this.emit('changed')
    await this.write()
  }

  private async write(): Promise<void> {
    const seen = [...this.seen.values()].map((f): [string, string] => [f.path, f.id])
    await writeJsonAtomic(this.file, { folders: this.folders, seen } satisfies WorkspaceFile, { guarded: true })
  }

  private serially<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Stops watching the folder and the workspaces in it: a watched folder can't be moved or deleted. */
  private release(folder: string): void {
    for (const [key, watcher] of this.watchers) {
      if (!inFolder(key, folder)) continue
      watcher.close()
      this.watchers.delete(key)
    }
  }

  /** The folder `from` is now `to`: what lies in it, as workspace or as seen, is there now too. */
  private async moved(from: string, to: string): Promise<void> {
    const seen = new Map<string, SeenFolder>()
    for (const entry of this.seen.values()) {
      const path = movedPath(entry.path, from, to) ?? entry.path
      seen.set(folderKey(path), { path, id: entry.id })
    }
    this.seen = seen
    const moving = this.folders.filter((f) => inFolder(f, from))
    if (moving.length > 0) {
      // In a workspace now: below it, like a new one; otherwise where it was.
      let folders = this.folders.map((f) => movedPath(f, from, to) ?? f)
      for (const path of moving.map((f) => movedPath(f, from, to)!)) {
        const rest = folders.filter((f) => f !== path)
        if (workspaceOf(path, rest)) folders = placeIn(rest, path)
      }
      this.folders = unique(folders)
    }
    // The workspaces it went from and to show it at once; also the moved ones are watched again.
    await this.save()
  }

  /** The workspaces and the folders in them (not hidden ones), with their identity. */
  private async scan(): Promise<Map<string, SeenFolder>> {
    const found = new Map<string, SeenFolder>()
    const add = async (path: string) => {
      const info = await stat(path, { bigint: true }).catch(() => null)
      if (!info?.isDirectory()) return
      found.set(folderKey(path), { path, id: info.ino > 0n ? `${info.dev}:${info.ino}` : '' })
    }
    await Promise.all(
      this.folders.map(async (folder) => {
        await add(folder)
        const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
        await Promise.all(entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => add(join(folder, e.name))))
      }),
    )
    return found
  }

  private async detectNow(): Promise<void> {
    if (!this.follower) return
    const found = await this.scan()
    const came = new Map<string, string>()
    for (const [key, folder] of found) if (folder.id && !this.seen.has(key)) came.set(folder.id, folder.path)
    const moves: [from: string, to: string][] = []
    for (const [key, folder] of this.seen) {
      if (!folder.id || found.has(key)) continue
      const to = came.get(folder.id)
      // Not seen any more, but still there: its workspace was taken off the list.
      if (to && !existsSync(folder.path)) moves.push([folder.path, to])
    }
    const changed = found.size !== this.seen.size || [...found].some(([key, f]) => this.seen.get(key)?.id !== f.id)
    this.seen = found
    if (moves.length === 0) {
      if (changed) await this.write().catch((error) => console.warn('[workspaces] could not be saved', error))
      return
    }
    // What lies in a moved folder went along: only the outermost move counts.
    const outermost = moves.filter(([from]) => !moves.some(([other]) => other !== from && inFolder(from, other)))
    for (const [from, to] of outermost) await this.moved(from, to)
    // The moved workspaces' folders are seen now too.
    for (const [key, folder] of await this.scan()) if (!this.seen.has(key)) this.seen.set(key, folder)
    await this.write().catch((error) => console.warn('[workspaces] could not be saved', error))
    for (const [from, to] of outermost) {
      console.info(`[workspaces] ${from} was moved to ${to}`)
      await this.follower(from, to).catch((error) => console.warn(`[workspaces] could not follow ${from} to ${to}`, error))
    }
  }

  private async describe(path: string): Promise<Workspace> {
    const name = basename(path) || path
    const entries = await readdir(path, { withFileTypes: true }).catch(() => null)
    if (!entries) return { path, name, exists: false, projects: [], hasPrompt: false }
    const nested = new Set(this.folders.map(folderKey))
    const projects = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !nested.has(folderKey(join(path, e.name))))
      .map((e) => e.name)
      .sort(new Intl.Collator('de', { sensitivity: 'base', numeric: true }).compare)
    const prompt = await readFile(join(path, WORKSPACE_PROMPT_FILE), 'utf8').catch(() => '')
    return { path, name, exists: true, projects, hasPrompt: stripBom(prompt).trim().length > 0 }
  }

  /** Watches the workspace folders (not their subfolders) for projects that come and go. */
  private syncWatchers(): void {
    const keys = new Set(this.folders.map(folderKey))
    for (const [key, watcher] of this.watchers) {
      if (keys.has(key)) continue
      watcher.close()
      this.watchers.delete(key)
    }
    for (const path of this.folders) {
      const key = folderKey(path)
      if (this.watchers.has(key)) continue
      try {
        const watcher = watch(path, { persistent: false }, () => this.changedSoon())
        // A folder that goes away (or a drive) ends the watch; the list then shows it as missing.
        watcher.on('error', () => {
          watcher.close()
          this.watchers.delete(key)
          this.changedSoon()
        })
        this.watchers.set(key, watcher)
      } catch {
        // Missing for now: listed as missing, watched once it is added again.
      }
    }
  }

  private changedSoon(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      // A folder that went and one that came may be one moved: followed before the list is read again.
      void this.detectMoves()
        .catch((error) => console.warn('[workspaces] could not look for moved folders', error))
        .finally(() => this.emit('changed'))
    }, CHANGE_DELAY_MS)
  }
}

/** Without trailing separators, as folders are listed and compared; on Windows with the drive upper case (`F:\`). */
function clean(path: string): string {
  const trimmed = path.trim().replace(TRAILING_SEPARATORS, '')
  return process.platform === 'win32' ? windowsPath(trimmed) : trimmed
}

/** `folders` with `path` added: last, or in a workspace right below it and the others in it. */
function placeIn(folders: readonly string[], path: string): string[] {
  const outer = workspaceOf(path, folders)
  const at = outer ? folders.findLastIndex((f) => inFolder(f, outer)) + 1 : folders.length
  return [...folders.slice(0, at), path, ...folders.slice(at)]
}

function unique(paths: string[]): string[] {
  const seen = new Set<string>()
  return paths.filter((path) => {
    const key = folderKey(path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Ends with a line break unless empty, as text files do. */
function normalizePrompt(text: string): string {
  const trimmed = text.replace(/\r\n/g, '\n').trimEnd()
  return trimmed ? `${trimmed}\n` : ''
}
