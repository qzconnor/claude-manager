import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { folderKey, TRAILING_SEPARATORS, windowsPath } from '@shared/folders'
import type { Workspace, WorkspaceCreateInput } from '@shared/types'
import { WORKSPACE_PROMPT_FILE, workspaceNameError, workspacesContaining } from '@shared/workspaces'
import { readJsonSync, writeJsonAtomic } from '../lib/json-file'
import { TypedEmitter } from '../lib/typed-emitter'

/** The prompt of one workspace a session lies in. */
export interface WorkspacePrompt {
  path: string
  name: string
  text: string
}

interface WorkspaceFile {
  folders: string[]
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

  constructor(userDataDir: string) {
    super()
    this.file = join(userDataDir, 'workspaces.json')
  }

  init(): void {
    const data = readJsonSync<Partial<WorkspaceFile>>(this.file)
    const folders = Array.isArray(data?.folders) ? data.folders : []
    this.folders = unique(folders.filter((f): f is string => typeof f === 'string' && isAbsolute(f)).map(clean))
    this.syncWatchers()
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

  async list(): Promise<Workspace[]> {
    return Promise.all(this.folders.map((path) => this.describe(path)))
  }

  /** Makes the folder `parent\name` with a `cm_prompts.md` and lists it as a workspace. */
  async create(input: WorkspaceCreateInput): Promise<Workspace> {
    const error = workspaceNameError(input.name)
    if (error) throw new Error(error)
    if (!isAbsolute(input.parent)) throw new Error('Wähle den Ordner, in dem der Workspace entstehen soll.')
    const path = join(clean(input.parent), input.name.trim())
    if (existsSync(path)) {
      throw new Error(`„${path}“ gibt es schon. Vorhandene Ordner werden über ihr Kontextmenü zum Workspace.`)
    }
    await mkdir(path, { recursive: true })
    await writeFile(join(path, WORKSPACE_PROMPT_FILE), normalizePrompt(input.prompt), 'utf8')
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

  private async add(path: string): Promise<Workspace> {
    const key = folderKey(path)
    if (!this.folders.some((f) => folderKey(f) === key)) {
      this.folders = [...this.folders, path]
      await this.save()
    } else {
      this.changedSoon()
    }
    return this.describe(path)
  }

  private async save(): Promise<void> {
    this.syncWatchers()
    this.emit('changed')
    await writeJsonAtomic(this.file, { folders: this.folders } satisfies WorkspaceFile)
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
      this.emit('changed')
    }, CHANGE_DELAY_MS)
  }
}

/** Without trailing separators, as folders are listed and compared; on Windows with the drive upper case (`F:\`). */
function clean(path: string): string {
  const trimmed = path.trim().replace(TRAILING_SEPARATORS, '')
  return process.platform === 'win32' ? windowsPath(trimmed) : trimmed
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
