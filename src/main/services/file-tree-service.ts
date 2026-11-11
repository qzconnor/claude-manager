import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { readdirSync, watch, type FSWatcher } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathProblem } from '@shared/file-names'
import { folderKey } from '@shared/folders'
import type {
  ContentFile,
  ContentMatch,
  ContentSearchResult,
  FileDiff,
  FileEntry,
  FileListing,
  FileSearchList,
  FileTouch,
  FileTreeWatch,
  GitFileState,
  GitFileStatus,
  GitTreeStatus,
} from '@shared/types'
import type { FileActivity } from '../lib/hook-events'
import { decodeText, decodeUtf16, isUtf16 } from '../lib/text-encoding'
import { TypedEmitter } from '../lib/typed-emitter'
import type { Trash } from './theme-service'

/**
 * A folder or file of a tree as the renderer names it: relative to the root, its parts joined with `/`,
 * nothing that leads out of the root. On Windows `\` separates folders too and `:` names another
 * drive or a stream of a file, so neither is part of such a path there.
 */
export function isTreePath(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
  if (typeof value !== 'string' || value.includes('\0')) return false
  if (platform === 'win32' && /[\\:]/.test(value)) return false
  return value === '' || value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

/** Not shown in the tree, as in VS Code's Explorer (`files.exclude`); `desktop.ini` is hidden on Windows anyway. */
const HIDDEN = new Set(['.git', '.svn', '.hg', 'CVS', '.DS_Store', 'Thumbs.db', 'desktop.ini'])
/** The most entries of one folder the tree gets; the rest is counted. */
const MAX_ENTRIES = 5000
/** The most changed and ignored paths of a status. */
const MAX_STATUS_PATHS = 20_000
/** A folder outside a repository is asked again after this long (ms), or at once when `.git` appears in it. */
const NO_REPO_MS = 15_000
/**
 * What git keeps in its folder that tells nothing about the state the tree shows: objects (a fetch,
 * a gc), the reflog, LFS's cache, hooks, notes of the last commit and fetch. Their refs come along.
 */
const GIT_NOISE = new Set(['objects', 'logs', 'lfs', 'hooks', 'COMMIT_EDITMSG', 'FETCH_HEAD', 'ORIG_HEAD', 'gc.log', 'gc.pid'])
/** The most files the search goes through. */
const MAX_SEARCH_FILES = 100_000
/** A folder without git: how long and how deep the search may walk it. */
const WALK_BUDGET_MS = 3000
const WALK_MAX_DEPTH = 16
/** Folders a walk without git leaves out, they are big and rarely searched. */
const WALK_SKIPPED = new Set([...HIDDEN, 'node_modules'])
/** Changes are reported together after this long (ms). */
const BATCH_MS = 200
/** A watcher that failed is set up again after this long. */
const WATCH_RETRY_MS = 30_000
/** The most trees and folders watched at once. */
const MAX_WATCHED_ROOTS = 64
const MAX_WATCHED_DIRS = 2000
/** A file bigger than this isn't shown, nor a diff longer than that (characters). */
const MAX_DIFF_FILE_BYTES = 4 * 1024 * 1024
const MAX_PATCH_CHARS = 4 * 1024 * 1024
/** An image bigger than this shows no preview. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** Images the diff shows as such, by extension; SVG is text and shows as its source. */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
}
/** Lines of context around the changes, and enough of them for the whole file. */
const DIFF_CONTEXT = 3
const FULL_CONTEXT = 1_000_000
/** A commit only counts as Claude's while it is this fresh (s): a failed `git commit` leaves an older one at HEAD. */
const FRESH_COMMIT_S = 120
/** The most files of a commit that light up. */
const MAX_COMMIT_FILES = 200
/** A shell command running longer than this (ms) no longer counts: what changes then isn't taken for its writes. */
const MAX_SHELL_MS = 10 * 60_000
/** Changes this long after a shell command ended are still its own (ms): the watcher reports a little late. */
const SHELL_SETTLE_MS = 800
/** The most files one shell command lights up as written. */
const MAX_SHELL_WRITES = 50
/** A file counts as written by a command if it changed at most this long before it started (ms, clocks differ a little). */
const MTIME_SLACK_MS = 1000
/** A file another session's tool is about to write is that session's for this long (ms; it may wait for permission). */
const TOOL_WRITE_MS = 60_000
/** The most files about to be written by tools that are remembered. */
const MAX_TOOL_WRITES = 500
/** The most changed files of git's status looked at after a command no tree watched. */
const MAX_SHELL_SCAN = 2000
/** The most changes of a moment asked about with `git check-ignore` (a build writes thousands); the rest count not. */
const MAX_IGNORE_CHECK = 400
/** Paths per `git check-ignore`, for the length of a command line on Windows. */
const IGNORE_CHECK_CHUNK = 100
/** Folders whose changes are no writes worth showing: packages, git's own. */
const SHELL_SKIPPED = new Set(['node_modules', '.git'])
/** Windows and macOS watch a folder with everything below it at the cost of one handle; Linux needs one per folder. */
const RECURSIVE = process.platform === 'win32' || process.platform === 'darwin'
/** The most lines a content search reads; it stops there. */
export const MAX_GREP_MATCHES = 1000
/** A content search gives up after this long (ms), with what it found so far. */
const GREP_MS = 15_000
/** Of a longer line, the part around its first hit is shown (characters). */
const MAX_MATCH_TEXT = 240
/** Before the first hit in such a part (characters). */
const MATCH_LEAD = 60
/** Names that differ only in case name the same entry (NTFS, APFS as they come). */
const CASE_BLIND = process.platform === 'win32' || process.platform === 'darwin'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Folders first, then by name, numbers by their value (`file2` before `file10`). */
export function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.dir !== b.dir) return a.dir ? -1 : 1
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

interface WatchedRoot {
  /** The folder as the first tree named it; watched by that path. */
  path: string
  /** How the trees spell the folder: each gets the changes. */
  roots: Set<string>
  /** The whole folder (Windows, macOS). */
  recursive: FSWatcher | null
  /** Linux: one watcher per open folder, by its path relative to the root ('' is the root). */
  dirs: Map<string, FSWatcher>
  /** The repository's git folder, for commits, checkouts and staging. */
  gitDir: string | null
  /** Its watchers (see `watchGitDir`). */
  git: Closable | null
  /** The folders the trees show (relative), as `watch` was told. */
  shown: Set<string>
  /** Folders whose entries changed since the last report. */
  pending: Set<string>
  gitChanged: boolean
  repoChanged: boolean
  timer: NodeJS.Timeout | null
  /** Watches again what failed (see `retryWatch`). */
  retry: NodeJS.Timeout | null
}

/** A shell command of Claude's while it runs: the files that change in its folder are what it writes. */
interface RunningShell {
  terminalId: string
  cwd: string
  start: number
  /** Files lit up already, and changes not yet looked at. */
  reported: Set<string>
  pending: Set<string>
  timer: NodeJS.Timeout | null
  /** Its end: when it runs too long, or a moment after it ended. */
  expiry: NodeJS.Timeout
  /** Looked for its writes in git's status once it ended (no tree watched its folder). */
  scanned: boolean
}

type Events = {
  /**
   * Entries of these folders (relative, '' is the root) may have changed; `git`: also what git sees
   * (see `gitMayTell`); `repo`: the repository itself (its index, HEAD, refs: a commit, a checkout).
   */
  changed: [root: string, dirs: string[], git: boolean, repo: boolean]
  /** Files a session's Claude reads, searches, writes or commits. */
  touched: [terminalId: string, touches: FileTouch[]]
}

/**
 * What the file tree of a tab shows: a folder's entries, git's view of the files and the files for
 * the search. Watches the trees on screen and reports changes, so the tree follows Claude's edits.
 */
export class FileTreeService extends TypedEmitter<Events> {
  /** By `folderKey` of the trees' folder. */
  private readonly watched = new Map<string, WatchedRoot>()
  /** Shell commands of Claude's that run, by session terminal and tool call. */
  private readonly shells = new Map<string, RunningShell>()
  /** Where each folder lies in its repository (`git rev-parse --show-prefix`); only hits are kept. */
  private readonly prefixes = new Map<string, string>()
  private readonly gitDirs = new Map<string, string>()
  /** By folder: the environment that switches off the filters its repository defines (see `filterGuard`). */
  private readonly guards = new Map<string, Promise<Record<string, string>>>()
  /** Folders outside a repository, with when that was found out (see `NO_REPO_MS`). */
  private readonly noRepo = new Map<string, number>()
  /** By `folderKey`: what git ignores there (folders whole end with `/`, like `node_modules/`), from the last status. */
  private readonly ignored = new Map<string, Set<string>>()
  /** Files the tools of a session are about to write (PreToolUse), by `pathKey`: no command of another session writes them. */
  private readonly toolWrites = new Map<string, { terminalId: string; at: number }>()
  /** The content search of each tree (by `folderKey`) that runs; a newer one ends it. */
  private readonly greps = new Map<string, ChildProcess>()

  /** `trash`: Electron's `shell.trashItem`; without it nothing is deleted. */
  constructor(private readonly trashItem: Trash = () => Promise.reject(new Error('Kein Papierkorb'))) {
    super()
  }

  async list(dir: string): Promise<FileListing> {
    const dirents = await readdir(dir, { withFileTypes: true })
    const entries = await Promise.all(
      dirents
        .filter((d) => !HIDDEN.has(d.name))
        .map(async (d): Promise<FileEntry> => {
          if (!d.isSymbolicLink()) return { name: d.name, dir: d.isDirectory(), link: false, broken: false }
          try {
            return { name: d.name, dir: (await stat(join(dir, d.name))).isDirectory(), link: true, broken: false }
          } catch {
            return { name: d.name, dir: false, link: true, broken: true }
          }
        }),
    )
    entries.sort(compareEntries)
    return { entries: entries.slice(0, MAX_ENTRIES), omitted: Math.max(0, entries.length - MAX_ENTRIES) }
  }

  /**
   * Makes an empty file, or a folder (`dir`), at `path` in the tree of `root`, with the folders on its
   * way; never over an entry that is there already.
   */
  async create(root: string, path: string, dir: boolean): Promise<void> {
    const target = this.entryOf(root, path, true)
    try {
      await mkdir(dirname(target), { recursive: true })
      if (dir) await mkdir(target)
      else await writeFile(target, '', { flag: 'wx' })
    } catch (error) {
      throw new Error(fileError(error, path))
    }
  }

  /** Renames the entry `from` in the tree of `root` to `to`; never over another entry. */
  async rename(root: string, from: string, to: string): Promise<void> {
    const source = this.entryOf(root, from, false)
    const target = this.entryOf(root, to, true)
    if (source === target) return
    // rename() would replace a file there without a word. Where case doesn't tell names apart, the
    // same name in another case is the entry itself.
    const itself = CASE_BLIND && source.toLowerCase() === target.toLowerCase()
    try {
      if (!itself && (await exists(target))) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      await rename(source, target)
    } catch (error) {
      throw new Error(fileError(error, (error as NodeJS.ErrnoException).code === 'ENOENT' ? from : to))
    }
  }

  /** Moves the entry `path` in the tree of `root` to the recycle bin. */
  async trash(root: string, path: string): Promise<void> {
    const target = this.entryOf(root, path, false)
    try {
      await lstat(target)
      await this.trashItem(target)
    } catch (error) {
      // shell.trashItem fails without a code, in English.
      if ((error as NodeJS.ErrnoException).code) throw new Error(fileError(error, path))
      throw new Error(`„${path.split('/').pop()}“ ließ sich nicht in den Papierkorb verschieben (${error instanceof Error ? error.message : String(error)}).`)
    }
  }

  /**
   * The lines of the files of the open tree of `root` that hold `query` (as it is, any case), by `git
   * grep`: binary files and what git ignores are left out, files git doesn't know yet are in. Outside a
   * repository the same with `--no-index` (and the `.gitignore` files there). Ends at `MAX_GREP_MATCHES`
   * lines or after `GREP_MS`; a newer search of the tree ends this one.
   */
  async grep(root: string, query: string): Promise<ContentSearchResult> {
    const key = folderKey(root)
    if (!this.watched.has(key)) throw new Error('Der Ordner ist in keinem offenen Dateibaum.')
    this.greps.get(key)?.kill()
    const repo = (await this.prefix(root)) !== null
    // Config that would change the output (`grep.column`, `grep.fullName`) is set back.
    const args = [
      ...GUARD,
      ...['-c', 'grep.column=false', '-c', 'grep.fullName=false', '-c', 'grep.lineNumber=true'],
      'grep',
      ...(repo ? ['--untracked'] : ['--no-index', '--exclude-standard']),
      ...['-n', '-I', '-z', '-F', '-i', '--no-color', '-e', query],
    ]
    const env = repo ? await this.guard(root) : {}
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: root, windowsHide: true, env: { ...process.env, ...env } })
      this.greps.set(key, child)
      const chunks: Buffer[] = []
      let lines = 0
      let truncated = false
      const stop = () => {
        truncated = true
        child.kill()
      }
      const timer = setTimeout(stop, GREP_MS)
      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return
        let end = chunk.length
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] !== 0x0a) continue
          if (++lines === MAX_GREP_MATCHES) {
            end = i + 1
            stop()
            break
          }
        }
        chunks.push(end === chunk.length ? chunk : chunk.subarray(0, end))
      })
      child.stderr.resume()
      child.on('error', (error) => {
        clearTimeout(timer)
        if (this.greps.get(key) === child) this.greps.delete(key)
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
        reject(new Error(missing ? 'Für die Suche im Inhalt braucht die App Git.' : error.message))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (this.greps.get(key) === child) this.greps.delete(key)
        // 1: nothing found; ended by a newer search or the limit: what was found.
        if (code !== 0 && code !== 1 && !truncated && !child.killed) return reject(new Error('Die Suche im Inhalt ist fehlgeschlagen.'))
        const files = parseGrep(Buffer.concat(chunks).toString('utf8'), query)
        resolve({ files, matches: files.reduce((sum, file) => sum + file.matches.length, 0), truncated })
      })
    })
  }

  /**
   * Where the entry `path` of an open tree of `root` lies on disk. Paths out of the tree, into `.git`
   * or in folders no tree shows are refused; `named`: the path gets a new name, checked like one.
   */
  private entryOf(root: string, path: string, named: boolean): string {
    if (!this.watched.has(folderKey(root))) throw new Error('Der Ordner ist in keinem offenen Dateibaum.')
    if (!isTreePath(path) || path === '') throw new Error('Ungültiger Pfad.')
    const problem = named ? pathProblem(path, process.platform) : path.split('/').some((part) => part.toLowerCase() === '.git') ? '„.git“ gehört Git.' : null
    if (problem) throw new Error(problem)
    return join(root, ...path.split('/'))
  }

  /** Null outside a repository and without git. */
  async status(root: string): Promise<GitTreeStatus | null> {
    const prefix = await this.prefix(root)
    if (prefix === null) {
      this.ignored.delete(folderKey(root))
      return null
    }
    const env = await this.guard(root)
    const [status, numstat] = await Promise.all([
      runGit(
        root,
        ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--ignored=matching', '--untracked-files=normal', '--', '.'],
        env,
      ),
      // Fails before the first commit; the line counts are missing then.
      runGit(root, ['--no-optional-locks', 'diff', '--numstat', '--no-textconv', '--no-ext-diff', '-z', 'HEAD', '--', '.'], env),
    ])
    if (status === null) return null
    const result = parseGitStatus(status, numstat ?? '', prefix)
    this.ignored.set(folderKey(root), new Set(result.ignored))
    return result
  }

  /**
   * A file's changes since the last commit (`path` relative to `root`): staged and unstaged together,
   * as `git diff HEAD` shows them. Without changes, or outside a repository, the file as it is; so too
   * when only its name or mode changed (the patch has no hunk then).
   */
  async diff(root: string, path: string, full: boolean): Promise<FileDiff> {
    if (!isTreePath(path) || path === '') throw new Error('Diese Datei liegt nicht im Ordner.')
    const file = join(root, ...path.split('/'))
    const result: FileDiff = { patch: '', text: null, repo: false, binary: false, tooLarge: false, missing: false }
    const info = await stat(file).catch(() => null)
    if (info?.isDirectory()) return this.submoduleDiff(root, path, full)
    if (info && !info.isFile()) throw new Error('Das ist keine Datei.')
    result.missing = info === null
    const prefix = await this.prefix(root)
    if (prefix !== null) {
      const patch = await this.patch(root, `${prefix}${path}`, full)
      if (patch !== null) {
        result.repo = true
        if (patch.length > MAX_PATCH_CHARS) result.tooLarge = true
        else {
          result.patch = patch
          result.binary = /^Binary files /m.test(patch)
          const utf16 = result.binary && info ? await this.utf16Patch(root, `${prefix}${path}`, patch, file, full) : null
          if (utf16 !== null && utf16.length <= MAX_PATCH_CHARS) {
            result.patch = utf16
            result.binary = false
          }
        }
      }
    }
    const type = IMAGE_TYPES[/\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '']
    if (type) {
      // Changed since the last commit (patch): as it was, under its old name when `git mv` moved it.
      const from = /^rename from (.+)$/m.exec(result.patch)?.[1] ?? `${prefix ?? ''}${path}`
      const [before, after] = await Promise.all([
        result.patch ? runGitBuffer(root, ['--no-optional-locks', 'cat-file', 'blob', `HEAD:${from}`]) : null,
        info && info.size <= MAX_IMAGE_BYTES ? readFile(file).catch(() => null) : null,
      ])
      const url = (bytes: Buffer | null) => (bytes && bytes.length <= MAX_IMAGE_BYTES ? `data:${type};base64,${bytes.toString('base64')}` : null)
      result.image = { before: url(before), after: url(after) }
      result.binary = true
      if (info && info.size > MAX_IMAGE_BYTES) result.tooLarge = true
      return result
    }
    if (!info || result.binary || result.tooLarge || /^@@ /m.test(result.patch)) return result
    if (info.size > MAX_DIFF_FILE_BYTES) {
      result.tooLarge = true
      return result
    }
    const buffer = await readFile(file)
    if (isUtf16(buffer)) result.text = decodeUtf16(buffer)
    // A NUL byte early on: not text.
    else if (buffer.subarray(0, 8000).includes(0)) result.binary = true
    else result.text = decodeText(buffer)
    return result
  }

  /**
   * The patch of a UTF-16 file (as `>` writes it in Windows PowerShell 5.1), which git takes for binary
   * (`patch`): both sides decoded and compared by git as UTF-8 (`--no-index`), under the head of git's
   * patch. Null when neither side is UTF-16, or for a side git can't give.
   */
  private async utf16Patch(root: string, top: string, patch: string, file: string, full: boolean): Promise<string | null> {
    // Renamed with `git mv`: the old side is at the old path (git quotes unusual names; then there is none).
    const from = /^rename from (.+)$/m.exec(patch)?.[1] ?? top
    const [before, now] = await Promise.all([
      runGitBuffer(root, ['--no-optional-locks', 'cat-file', 'blob', `HEAD:${from}`]),
      readFile(file).catch(() => null),
    ])
    if (!before || !now || (!isUtf16(before) && !isUtf16(now))) return null
    if (before.length > MAX_DIFF_FILE_BYTES || now.length > MAX_DIFF_FILE_BYTES) return null
    const decode = (bytes: Buffer) => (isUtf16(bytes) ? decodeUtf16(bytes) : decodeText(bytes))
    const dir = await mkdtemp(join(tmpdir(), 'cm-diff-'))
    try {
      await Promise.all([writeFile(join(dir, 'a'), decode(before)), writeFile(join(dir, 'b'), decode(now))])
      const out = await runGitBuffer(
        dir,
        ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', `--unified=${full ? FULL_CONTEXT : DIFF_CONTEXT}`, '--', 'a', 'b'],
        undefined,
        // 1: they differ.
        [0, 1],
      )
      if (out === null) return null
      const hunks = out.toString('utf8')
      const at = hunks.search(/^@@ /m)
      // The same text in another encoding: the head alone, the file shows as it is.
      return patch.replace(/^Binary files .*\n?/m, '') + (at === -1 ? '' : hunks.slice(at))
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * What Claude does with files in a session, reported as `touched`: files of its tools at once, paths
   * from a command or a search once they turn out to be files, a commit with the files in it, and while
   * a shell command runs the files that change.
   */
  activity(terminalId: string, activity: FileActivity): void {
    if (activity.touches?.length) {
      this.emit('touched', terminalId, activity.touches)
      this.noteToolWrites(terminalId, activity.touches)
    }
    if (activity.maybe?.length) {
      void existingFiles(activity.maybe).then((touches) => {
        if (touches.length > 0) this.emit('touched', terminalId, touches)
      })
    }
    if (activity.commit) {
      void this.committedFiles(activity.commit).then((paths) => {
        if (paths.length > 0) this.emit('touched', terminalId, paths.map((path) => ({ path, kind: 'commit' as const })))
      })
    }
    const shell = activity.shell
    if (!shell) return
    const key = `${terminalId}\0${shell.id}`
    if (!shell.end) {
      this.dropShell(key)
      this.shells.set(key, {
        terminalId,
        cwd: shell.cwd,
        start: Date.now(),
        reported: new Set(),
        pending: new Set(),
        timer: null,
        expiry: setTimeout(() => this.dropShell(key), MAX_SHELL_MS),
        scanned: false,
      })
      return
    }
    const running = this.shells.get(key)
    if (shell.writes.length > 0) {
      const since = (running?.start ?? Date.now() - MAX_SHELL_MS) - MTIME_SLACK_MS
      // Named by the command (`> out.txt`): its own, whoever else works there.
      void changedFiles(shell.writes, since).then((paths) => this.reportWrites(terminalId, running, paths, true))
    }
    if (running) this.endShell(key, running)
  }

  /** A turn ended or a new one began: none of the session's commands runs any more (Esc stops one without a word). */
  endShells(terminalId: string): void {
    for (const [key, shell] of this.shells) if (shell.terminalId === terminalId) this.endShell(key, shell)
  }

  private endShell(key: string, shell: RunningShell): void {
    if (!shell.scanned && !this.watchedLive(shell.cwd)) {
      shell.scanned = true
      void this.scanShell(shell)
    }
    this.settleShell(key, shell)
  }

  /** Whether a tree's watcher saw every change in `cwd` as it happened (Windows, macOS: its whole folder). */
  private watchedLive(cwd: string): boolean {
    if (!RECURSIVE) return false
    for (const watched of this.watched.values()) if (watched.recursive && isInside(cwd, watched.path)) return true
    return false
  }

  /**
   * The writes of a command no tree watched (its tree is closed; Linux watches only open folders): what
   * git sees changed or new in its folder, changed since it started. Outside a repository: none.
   */
  private async scanShell(shell: RunningShell): Promise<void> {
    const prefix = await this.prefix(shell.cwd)
    if (prefix === null) return
    const args = ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', '.']
    const out = await runGit(shell.cwd, args, await this.guard(shell.cwd))
    if (out === null) return
    const paths = Object.entries(parseGitStatus(out, '', prefix).files)
      .filter(([, state]) => state.status !== 'deleted')
      .slice(0, MAX_SHELL_SCAN)
      .map(([path]) => join(shell.cwd, ...path.split('/')))
      .filter((path) => shellMayWrite(shell.cwd, path))
    this.reportWrites(shell.terminalId, shell, await changedFiles(paths, shell.start - MTIME_SLACK_MS))
  }

  /** Remembers the files a session's tools are about to write, for a while (see `onlyShellOf`). */
  private noteToolWrites(terminalId: string, touches: readonly FileTouch[]): void {
    const now = Date.now()
    for (const touch of touches) {
      if (touch.kind !== 'write') continue
      const key = pathKey(touch.path)
      // Last in the map: the oldest come first.
      this.toolWrites.delete(key)
      this.toolWrites.set(key, { terminalId, at: now })
    }
    for (const [key, write] of this.toolWrites) {
      if (this.toolWrites.size <= MAX_TOOL_WRITES && now - write.at <= TOOL_WRITE_MS) break
      this.toolWrites.delete(key)
    }
  }

  /**
   * Whether a change at `path` can only be a write of the commands of `terminalId`: no other session's
   * tool is about to write it, no command of another session runs where it lies. Else it is nobody's.
   */
  private onlyShellOf(terminalId: string, path: string): boolean {
    const tool = this.toolWrites.get(pathKey(path))
    if (tool && tool.terminalId !== terminalId && Date.now() - tool.at <= TOOL_WRITE_MS) return false
    for (const shell of this.shells.values()) if (shell.terminalId !== terminalId && shellMayWrite(shell.cwd, path)) return false
    return true
  }

  private settleShell(key: string, shell: RunningShell): void {
    clearTimeout(shell.expiry)
    shell.expiry = setTimeout(() => this.dropShell(key), SHELL_SETTLE_MS)
  }

  private dropShell(key: string): void {
    const shell = this.shells.get(key)
    if (!shell) return
    clearTimeout(shell.expiry)
    if (shell.timer) {
      clearTimeout(shell.timer)
      this.flushShell(shell)
    }
    this.shells.delete(key)
  }

  /** A file changed: a write of the shell commands running in its folder. */
  private noteShellWrite(path: string): void {
    for (const shell of this.shells.values()) {
      if (shell.reported.size >= MAX_SHELL_WRITES || !shellMayWrite(shell.cwd, path)) continue
      shell.pending.add(path)
      shell.timer ??= setTimeout(() => this.flushShell(shell), BATCH_MS)
    }
  }

  private flushShell(shell: RunningShell): void {
    shell.timer = null
    const paths = [...shell.pending]
    shell.pending.clear()
    void this.notIgnored(shell.cwd, paths)
      .then((kept) => changedFiles(kept, shell.start - MTIME_SLACK_MS))
      .then((changed) => this.reportWrites(shell.terminalId, shell, changed))
  }

  /**
   * `paths` (in `cwd`) without those git ignores: the output of a build, logs. The last status knows
   * most of them, a folder a build just made only git itself.
   */
  private async notIgnored(cwd: string, paths: string[]): Promise<string[]> {
    if (paths.length === 0 || (await this.prefix(cwd)) === null) return paths
    const checked = paths.slice(0, MAX_IGNORE_CHECK)
    const rel = checked.map((path) => relative(cwd, path).split(sep).join('/'))
    const ignored = new Set<string>()
    for (let i = 0; i < rel.length; i += IGNORE_CHECK_CHUNK) {
      // One ignored path per line (-z only with --stdin); exits with 1 when none is, which reads as null too.
      const out = await runGit(cwd, ['-c', 'core.quotePath=false', 'check-ignore', '--', ...rel.slice(i, i + IGNORE_CHECK_CHUNK)])
      for (const line of out?.split('\n') ?? []) if (line) ignored.add(line.replace(/\r$/, ''))
    }
    return checked.filter((_, i) => !ignored.has(rel[i]!))
  }

  /** `named`: the command named them, they are its own. */
  private reportWrites(terminalId: string, shell: RunningShell | undefined, paths: string[], named = false): void {
    const fresh: string[] = []
    for (const path of paths) {
      if (shell && (shell.reported.has(path) || shell.reported.size >= MAX_SHELL_WRITES)) continue
      if (!named && !this.onlyShellOf(terminalId, path)) continue
      shell?.reported.add(path)
      fresh.push(path)
    }
    if (fresh.length > 0) this.emit('touched', terminalId, fresh.map((path) => ({ path, kind: 'write' as const })))
  }

  /** A submodule, a folder git keeps as a commit: which commit it is at now, as `git diff` says it. */
  private async submoduleDiff(root: string, path: string, full: boolean): Promise<FileDiff> {
    const prefix = await this.prefix(root)
    const patch = prefix === null ? null : await this.patch(root, `${prefix}${path}`, full)
    if (!patch || !/^[-+ ]Subproject commit /m.test(patch)) throw new Error('Das ist keine Datei.')
    return { patch, text: null, repo: true, binary: false, tooLarge: false, missing: false }
  }

  /**
   * `git diff HEAD` of the file at `top` (from the top of the repository); null when git failed. A file
   * `git mv` moved is compared with the one it was instead of shown as new. Before the first commit
   * there is nothing to compare with: no changes (''), the tree shows the file as new.
   */
  private async patch(root: string, top: string, full: boolean): Promise<string | null> {
    const env = await this.guard(root)
    const diff = (paths: string[], renames: boolean) =>
      runGitText(
        root,
        [
          '--no-optional-locks',
          'diff',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          renames ? '--find-renames' : '--no-renames',
          `--unified=${full ? FULL_CONTEXT : DIFF_CONTEXT}`,
          'HEAD',
          '--',
          ...paths.map(topPathspec),
        ],
        env,
      )
    const patch = await diff([top], false)
    if (patch === null) return (await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])) === null ? '' : null
    if (!/^new file mode /m.test(patch)) return patch
    const from = await this.renamedFrom(root, top, env)
    if (from === null) return patch
    const renamed = await diff([from, top], true)
    // Changed too much since: git sees a deleted and a new file, both in the patch. Then as new.
    if (renamed === null || renamed.match(/^diff --git /gm)?.length !== 1 || !/^rename from /m.test(renamed)) return patch
    return renamed
  }

  /** Where the file at `top` was at HEAD, if a rename of it is staged (`git mv`); null else. */
  private async renamedFrom(root: string, top: string, env: Record<string, string>): Promise<string | null> {
    const out = await runGit(root, ['--no-optional-locks', 'diff', '--cached', '--no-relative', '--find-renames', '--name-status', '-z', 'HEAD'], env)
    // `R<score>`, the old and the new path; `M`, `A`, `D` … with one path.
    const tokens = out?.split('\0') ?? []
    for (let i = 0; i < tokens.length; i++) {
      const status = tokens[i]!
      if (!status.startsWith('R') && !status.startsWith('C')) {
        i++
        continue
      }
      if (status.startsWith('R') && tokens[i + 2] === top) return tokens[i + 1] ?? null
      i += 2
    }
    return null
  }

  /** The files of the commit at HEAD of the repository `cwd` lies in, if it was just made. */
  private async committedFiles(cwd: string): Promise<string[]> {
    const [cdup, time, names] = await Promise.all([
      // The way up from the folder as the session spells it: git's top is its real path (no link, no subst drive).
      runGit(cwd, ['rev-parse', '--show-cdup']),
      runGit(cwd, ['--no-optional-locks', 'log', '-1', '--no-show-signature', '--format=%ct', 'HEAD']),
      // --root: the first commit has no parent to compare with.
      runGit(cwd, ['--no-optional-locks', 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD']),
    ])
    if (cdup === null || !time || !names) return []
    const made = Number(time.trim())
    if (!Number.isFinite(made) || Date.now() / 1000 - made > FRESH_COMMIT_S) return []
    const files = names.split('\0').filter(Boolean)
    return files.slice(0, MAX_COMMIT_FILES).map((name) => resolve(cwd, cdup.trim(), name))
  }

  /** The files of `root` for the search: what git knows and doesn't ignore, else a walk through the folder. */
  async searchList(root: string): Promise<FileSearchList> {
    if ((await this.prefix(root)) !== null) {
      const out = await runGit(root, ['--no-optional-locks', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'])
      if (out !== null) {
        // A repository inside (not a submodule) comes as its folder, `vendor/lib/`: no file to find.
        const paths = [...new Set(out.split('\0').filter((path) => path !== '' && !path.endsWith('/')))]
        return { paths: paths.slice(0, MAX_SEARCH_FILES), truncated: paths.length > MAX_SEARCH_FILES }
      }
    }
    return walk(root)
  }

  /**
   * Watches these trees, replacing the ones of the previous call; changes come as `changed`, for each
   * spelling of the folder a tree was given with (`F:\Proj` and `f:\proj\` share one watcher).
   */
  watch(trees: readonly FileTreeWatch[]): void {
    const wanted = new Map<string, { roots: Set<string>; dirs: Set<string> }>()
    for (const tree of trees.slice(0, MAX_WATCHED_ROOTS)) {
      const key = folderKey(tree.root)
      const entry = wanted.get(key) ?? { roots: new Set<string>(), dirs: new Set(['']) }
      entry.roots.add(tree.root)
      for (const dir of tree.dirs.slice(0, MAX_WATCHED_DIRS)) entry.dirs.add(dir)
      wanted.set(key, entry)
    }
    for (const key of [...this.watched.keys()]) if (!wanted.has(key)) this.unwatch(key)
    for (const [key, { roots, dirs }] of wanted) {
      let watched = this.watched.get(key)
      if (!watched) {
        const fresh: WatchedRoot = {
          path: [...roots][0]!,
          roots,
          recursive: null,
          dirs: new Map(),
          gitDir: null,
          git: null,
          shown: dirs,
          pending: new Set(),
          gitChanged: false,
          repoChanged: false,
          timer: null,
          retry: null,
        }
        watched = fresh
        this.watched.set(key, fresh)
        if (RECURSIVE) fresh.recursive = this.watchRecursive(key, fresh)
        this.findGitDir(key, fresh)
      }
      watched.roots = roots
      watched.shown = dirs
      if (!RECURSIVE) this.watchDirs(key, watched, dirs)
    }
  }

  dispose(): void {
    for (const child of this.greps.values()) child.kill()
    this.greps.clear()
    for (const key of [...this.watched.keys()]) this.unwatch(key)
    for (const shell of this.shells.values()) {
      clearTimeout(shell.expiry)
      if (shell.timer) clearTimeout(shell.timer)
    }
    this.shells.clear()
  }

  private watchRecursive(key: string, watched: WatchedRoot): FSWatcher | null {
    const root = watched.path
    try {
      const watcher = watch(root, { recursive: true }, (event, file) => {
        if (!file) return this.note(key, '', true, true)
        const parts = file.toString().split(/[\\/]/)
        // The git folder inside the tree: its state, no entries the tree shows. `git init` makes it.
        const gitAt = parts.indexOf('.git')
        if (gitAt >= 0) {
          if (gitAt === 0 && !watched.git) this.repoAppeared(key, watched)
          if (gitStateChange(parts.slice(gitAt + 1))) this.note(key, null, true, true)
          return
        }
        const dir = parts.slice(0, -1).join('/')
        const git = this.gitMayTell(key, parts.join('/'), event)
        // In a folder git ignores whole and the tree doesn't show (`npm install`, a build): nothing to do.
        if (git || watched.shown.has(dir)) this.note(key, dir, git)
        // What git ignores (a build's output, a log) is no write worth showing.
        if (this.shells.size > 0 && !this.gitIgnores(key, parts.join('/'))) this.noteShellWrite(join(root, ...parts))
      })
      // Gone for a moment (a network drive, a folder replaced by a checkout): watched again later.
      watcher.on('error', () => {
        watcher.close()
        if (watched.recursive !== watcher) return
        watched.recursive = null
        this.retryWatch(key, watched)
      })
      return watcher
    } catch {
      this.retryWatch(key, watched)
      return null
    }
  }

  private watchDirs(key: string, watched: WatchedRoot, dirs: Set<string>): void {
    const root = watched.path
    for (const [dir, watcher] of watched.dirs) {
      if (dirs.has(dir)) continue
      watcher.close()
      watched.dirs.delete(dir)
    }
    for (const dir of dirs) {
      if (watched.dirs.has(dir)) continue
      try {
        const path = dir ? join(root, ...dir.split('/')) : root
        const watcher = watch(path, (event, file) => {
          const name = file?.toString()
          // `git init` in the tree: from now on its repository is watched too.
          const gitInit = !dir && name === '.git'
          if (gitInit && !watched.git) this.repoAppeared(key, watched)
          this.note(key, dir, gitInit || !name || this.gitMayTell(key, dir ? `${dir}/${name}` : name, event), gitInit)
          if (name && this.shells.size > 0 && !this.gitIgnores(key, dir ? `${dir}/${name}` : name)) this.noteShellWrite(join(path, name))
        })
        // Deleted or no longer readable: the tree lets go of it when it disappears there. Its own
        // folder is watched again later, while the tree is open.
        watcher.on('error', () => {
          watcher.close()
          if (watched.dirs.get(dir) === watcher) watched.dirs.delete(dir)
          if (!dir) this.retryWatch(key, watched)
        })
        watched.dirs.set(dir, watcher)
      } catch {
        // Gone already.
        if (!dir) this.retryWatch(key, watched)
      }
    }
  }

  /** `.git` appeared in the tree (`git init`, a clone): git is asked again at once. */
  private repoAppeared(key: string, watched: WatchedRoot): void {
    for (const root of watched.roots) this.noRepo.delete(root)
    this.findGitDir(key, watched)
  }

  /**
   * Whether a change at `path` (relative) may change what git sees; not inside a folder git ignores
   * whole, whose entry the last status has already. The folder itself coming or going (`rename`) does,
   * a `change` of it (Windows tells one whenever something inside changes) doesn't.
   */
  private gitMayTell(key: string, path: string, event: string): boolean {
    const ignored = this.ignored.get(key)
    if (!ignored || ignored.size === 0) return true
    // An ignored file or folder that is there already (a log a dev server writes to): its entry stays.
    if (event === 'change' && (ignored.has(path) || ignored.has(`${path}/`))) return false
    return !insideIgnoredDir(ignored, path)
  }

  /** Whether git ignores `path` (relative), as the last status of the folder said. */
  private gitIgnores(key: string, path: string): boolean {
    const ignored = this.ignored.get(key)
    return !!ignored && (ignored.has(path) || insideIgnoredDir(ignored, path))
  }

  /** Watches the tree's repository once there is one, also when `git init` makes it later. */
  private findGitDir(key: string, watched: WatchedRoot): void {
    void Promise.all([this.gitDir(watched.path), runGit(watched.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])]).then(
      ([gitDir, common]) => {
        // Not if the tree was let go meanwhile.
        if (this.watched.get(key) !== watched || !gitDir || watched.git) return
        watched.gitDir = gitDir
        watched.git = this.watchGitDir(key, watched, gitDir, common?.trim() || gitDir)
      },
    )
  }

  /**
   * Watches the repository's state: its index and HEAD (git writes them through a lock file it renames,
   * so folders are watched) and its refs, which push and fetch change, so ahead and behind follow. A
   * worktree has its index and HEAD in `gitDir`, the refs in the repository's `common` folder.
   * Windows and macOS watch the common folder whole (a worktree's lies in it); Linux its top, the
   * worktree's folder and the folders of the remotes' branches.
   */
  private watchGitDir(key: string, watched: WatchedRoot, gitDir: string, common: string): Closable | null {
    const changed = (parts: string[]) => {
      // Without watching below the top, FETCH_HEAD is what tells of a fetch.
      if (parts.length === 0 || gitStateChange(parts) || (!RECURSIVE && parts[0] === 'FETCH_HEAD')) this.note(key, null, true, true)
      // Filters added to its config are switched off too (see `guard`).
      const name = parts.at(-1)
      if (name === 'config' || name === 'config.worktree') for (const root of watched.roots) this.guards.delete(root)
    }
    const folders: { path: string; prefix: string[] }[] = []
    if (RECURSIVE && isInside(gitDir, common)) folders.push({ path: common, prefix: [] })
    else {
      folders.push({ path: gitDir, prefix: [] })
      if (!isInside(common, gitDir)) folders.push({ path: common, prefix: [] })
      const remotes = join(common, 'refs', 'remotes')
      if (!RECURSIVE) {
        for (const remote of safeReaddir(remotes)) folders.push({ path: join(remotes, remote), prefix: ['refs', 'remotes', remote] })
      }
    }
    const list: FSWatcher[] = []
    const bundle: Closable = { close: () => list.forEach((watcher) => watcher.close()) }
    for (const folder of folders) {
      try {
        const watcher = watch(folder.path, { recursive: RECURSIVE && folder.path === common && folders.length === 1 }, (_event, file) => {
          changed(file ? [...folder.prefix, ...file.toString().split(/[\\/]/)] : [])
        })
        watcher.on('error', () => {
          bundle.close()
          if (watched.git !== bundle) return
          watched.git = null
          this.retryWatch(key, watched)
        })
        list.push(watcher)
      } catch {
        // A remote's folder gone meanwhile; the repository's own is the one that counts.
        if (folder.path === gitDir || folder.path === common) {
          bundle.close()
          return null
        }
      }
    }
    return bundle
  }

  /** Watches what of the tree failed again after a while, while the tree is still open. */
  private retryWatch(key: string, watched: WatchedRoot): void {
    if (watched.retry) return
    watched.retry = setTimeout(() => {
      watched.retry = null
      if (this.watched.get(key) !== watched) return
      if (RECURSIVE && !watched.recursive) watched.recursive = this.watchRecursive(key, watched)
      if (!RECURSIVE && !watched.dirs.has('')) this.watchDirs(key, watched, new Set(['', ...watched.dirs.keys()]))
      if (!watched.git) this.findGitDir(key, watched)
      // What changed meanwhile isn't known: the tree reads its folder and state again.
      this.note(key, '', true, true)
    }, WATCH_RETRY_MS)
  }

  /** `dir`: a folder whose entries changed (null: none); `git`: what git sees may have changed; `repo`: the repository. */
  private note(key: string, dir: string | null, git: boolean, repo = false): void {
    const watched = this.watched.get(key)
    if (!watched) return
    if (dir !== null) watched.pending.add(dir)
    if (git) watched.gitChanged = true
    if (repo) watched.repoChanged = true
    watched.timer ??= setTimeout(() => {
      watched.timer = null
      const dirs = [...watched.pending]
      const { gitChanged, repoChanged } = watched
      watched.pending.clear()
      watched.gitChanged = false
      watched.repoChanged = false
      if (this.watched.get(key) !== watched) return
      for (const root of watched.roots) this.emit('changed', root, dirs, gitChanged, repoChanged)
    }, BATCH_MS)
  }

  private unwatch(key: string): void {
    const watched = this.watched.get(key)
    if (!watched) return
    if (watched.timer) clearTimeout(watched.timer)
    if (watched.retry) clearTimeout(watched.retry)
    watched.recursive?.close()
    watched.git?.close()
    for (const watcher of watched.dirs.values()) watcher.close()
    this.watched.delete(key)
  }

  private async prefix(root: string): Promise<string | null> {
    const known = this.prefixes.get(root)
    if (known !== undefined) return known
    // Outside a repository a busy folder (a dev server's logs) would ask git again for every change.
    const missed = this.noRepo.get(root)
    if (missed !== undefined && Date.now() - missed < NO_REPO_MS) return null
    const out = await runGit(root, ['rev-parse', '--show-prefix'])
    if (out === null) {
      this.noRepo.set(root, Date.now())
      return null
    }
    this.noRepo.delete(root)
    const prefix = out.trim()
    this.prefixes.set(root, prefix)
    return prefix
  }

  private async gitDir(root: string): Promise<string | null> {
    const known = this.gitDirs.get(root)
    if (known) return known
    const out = await runGit(root, ['rev-parse', '--absolute-git-dir'])
    const gitDir = out?.trim() || null
    if (gitDir) this.gitDirs.set(root, gitDir)
    return gitDir
  }

  /** The environment for git commands in `root` that read changed files (see `filterGuard`). */
  private guard(root: string): Promise<Record<string, string>> {
    let guard = this.guards.get(root)
    if (!guard) {
      guard = runGit(root, ['config', '--show-scope', '--name-only', '--includes', '--get-regexp', '^filter\\.']).then((out) =>
        filterGuard(out, process.env.GIT_CONFIG_COUNT),
      )
      this.guards.set(root, guard)
    }
    return guard
  }
}

/**
 * Whether a change in the git folder (`parts` below `.git`) may change what the tree shows: the index,
 * HEAD, refs, config, a merge; not objects, the reflog, lock files and the like (a fetch writes
 * hundreds). A submodule's git folder (`modules/<name>/…`) likewise.
 */
export function gitStateChange(parts: string[]): boolean {
  const name = parts.at(-1) ?? ''
  if (name.endsWith('.lock') || parts[0]?.startsWith('fsmonitor--daemon')) return false
  if (parts[0] === 'modules') return !parts.includes('objects') && !parts.includes('logs') && !parts.includes('lfs')
  // The folder of a worktree (`worktrees/<name>/…`): its index and HEAD.
  if (parts[0] === 'worktrees') return parts.length > 2 && !GIT_NOISE.has(parts[2]!)
  return !GIT_NOISE.has(parts[0] ?? '')
}

/** Something that ends watching. */
interface Closable {
  close(): void
}

/** The names in a folder; none when it is missing. */
/**
 * The lines `git grep -n -z` gave (`path\0line\0text`), by file in its order, each with where `query`
 * is in it (any case).
 */
export function parseGrep(out: string, query: string): ContentFile[] {
  const files: ContentFile[] = []
  for (const record of out.split('\n')) {
    const first = record.indexOf('\0')
    const second = first > 0 ? record.indexOf('\0', first + 1) : -1
    if (second < 0) continue
    const path = record.slice(0, first)
    const line = Number(record.slice(first + 1, second))
    if (!Number.isInteger(line) || line < 1) continue
    let file = files.at(-1)
    if (!file || file.path !== path) {
      file = { path, matches: [] }
      files.push(file)
    }
    file.matches.push(matchOf(record.slice(second + 1).replace(/\r$/, ''), line, query))
  }
  return files
}

/** A line found, without its indent; of a long one the part around its first hit. */
function matchOf(full: string, line: number, query: string): ContentMatch {
  const text = full.trimStart()
  const needle = query.toLowerCase()
  let shown = text
  if (text.length > MAX_MATCH_TEXT) {
    const first = text.toLowerCase().indexOf(needle)
    const start = Math.max(0, Math.min(first - MATCH_LEAD, text.length - MAX_MATCH_TEXT))
    const end = start + MAX_MATCH_TEXT
    shown = `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
  }
  const ranges: [number, number][] = []
  const lower = shown.toLowerCase()
  // Lowercase of some letters is longer (İ): the hits wouldn't lie where they are.
  if (lower.length === shown.length && needle.length > 0) {
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) ranges.push([at, at + needle.length])
  }
  return { line, text: shown, ranges }
}

/** Why a file operation on `path` failed, in words for the user. */
function fileError(error: unknown, path: string): string {
  const name = `„${path.split('/').pop()}“`
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case 'EEXIST':
      return `${name} gibt es dort schon.`
    case 'ENOENT':
      return `${name} gibt es nicht mehr.`
    case 'ENOTDIR':
      return 'Ein Teil des Pfads ist eine Datei, kein Ordner.'
    case 'EACCES':
    case 'EPERM':
    case 'EBUSY':
      return `Zugriff auf ${name} verweigert. Vielleicht hat ein Programm die Datei oder etwas im Ordner gerade offen.`
    default:
      return error instanceof Error ? error.message : String(error)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** Whether `path` (relative) lies in one of the folders (ending with `/`) of `ignored`. */
function insideIgnoredDir(ignored: Set<string>, path: string): boolean {
  for (let at = path.indexOf('/'); at >= 0; at = path.indexOf('/', at + 1)) {
    if (ignored.has(path.slice(0, at + 1))) return true
  }
  return false
}

/** Whether `child` is `parent` or lies in it. */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** A path as a key: Windows doesn't tell upper from lower case. */
function pathKey(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

/** A path from the top of the repository, as it is (no wildcards), wherever git runs in it. */
function topPathspec(path: string): string {
  return `:(top,literal)${path}`
}

/**
 * The tree only looks at a folder, perhaps one just unpacked from elsewhere with its `.git` folder:
 * nothing its repository configures may run then. git would start its fsmonitor program for every
 * command that reads the index; diff programs and textconv are switched off where the tree diffs.
 */
const GUARD = ['-c', 'core.fsmonitor=false']

/**
 * The filters (`filter.<name>.clean`/`process`) the repository's own config defines, from
 * `git config --show-scope --name-only --get-regexp ^filter\.`, switched off by environment
 * (`GIT_CONFIG_COUNT`, after the `existing` ones; a `-c` would break on a name with `=`): git runs
 * them on every changed file it compares. Those of the user's own config (global, system) stay.
 */
export function filterGuard(out: string | null, existing?: string): Record<string, string> {
  const names = new Set<string>()
  for (const line of (out ?? '').split('\n')) {
    const [scope, key] = line.replace(/\r$/, '').split('\t')
    if ((scope !== 'local' && scope !== 'worktree') || !key) continue
    const match = /^filter\.(.+)\.[^.]+$/s.exec(key)
    if (match) names.add(match[1]!)
  }
  const env: Record<string, string> = {}
  const first = Number(existing) || 0
  let count = first
  for (const name of names) {
    for (const [key, value] of [
      ['clean', ''],
      ['process', ''],
      ['required', 'false'],
    ]) {
      env[`GIT_CONFIG_KEY_${count}`] = `filter.${name}.${key}`
      env[`GIT_CONFIG_VALUE_${count}`] = value!
      count++
    }
  }
  if (count > first) env.GIT_CONFIG_COUNT = String(count)
  return env
}

/** git's output, untouched (with `-z` a trim could cut a name); null when it failed or is missing. */
function runGit(cwd: string, args: string[], env?: Record<string, string>): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...GUARD, ...args],
      {
        cwd,
        windowsHide: true,
        timeout: 15_000,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: env && Object.keys(env).length > 0 ? { ...process.env, ...env } : undefined,
      },
      (error, stdout) => resolve(error ? null : stdout),
    )
  })
}

/**
 * git's output as bytes; null when it failed (an exit code not in `ok`) or is missing. File contents
 * in a diff are in the file's own encoding, not UTF-8.
 */
function runGitBuffer(cwd: string, args: string[], env?: Record<string, string>, ok: number[] = [0]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...GUARD, ...args],
      {
        cwd,
        windowsHide: true,
        timeout: 15_000,
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
        env: env && Object.keys(env).length > 0 ? { ...process.env, ...env } : undefined,
      },
      (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
        resolve(ok.includes(code) && !error?.killed ? stdout : null)
      },
    )
  })
}

/** git's output with files' contents read as `decodeText` reads them (Latin-1 lines without `�`). */
async function runGitText(cwd: string, args: string[], env?: Record<string, string>): Promise<string | null> {
  const out = await runGitBuffer(cwd, args, env)
  return out === null ? null : decodeText(out)
}

/** A folder without git: its files up to the limits, leaving out what is hidden in the tree and `node_modules`. */
async function walk(root: string): Promise<FileSearchList> {
  const paths: string[] = []
  const deadline = Date.now() + WALK_BUDGET_MS
  let queue: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: '', depth: 0 }]
  let truncated = false
  while (queue.length > 0) {
    const next: typeof queue = []
    for (const dir of queue) {
      if (paths.length >= MAX_SEARCH_FILES || Date.now() > deadline) return { paths, truncated: true }
      let dirents
      try {
        dirents = await readdir(dir.abs, { withFileTypes: true })
      } catch {
        continue
      }
      for (const d of dirents) {
        if (WALK_SKIPPED.has(d.name)) continue
        const rel = dir.rel ? `${dir.rel}/${d.name}` : d.name
        // Links are not followed: they may lead in a circle.
        if (d.isDirectory()) {
          if (dir.depth < WALK_MAX_DEPTH) next.push({ abs: join(dir.abs, d.name), rel, depth: dir.depth + 1 })
          else truncated = true
        } else {
          paths.push(rel)
        }
      }
    }
    queue = next
  }
  return { paths, truncated }
}

/**
 * `git status --porcelain=v2 -z --branch --ignored=matching` and `git diff --numstat -z HEAD` of a folder,
 * with the paths relative to the folder (`prefix` is where it lies in the repository, `sub/dir/`).
 */
export function parseGitStatus(status: string, numstat: string, prefix: string): GitTreeStatus {
  const result: GitTreeStatus = { branch: null, commit: null, upstream: null, ahead: 0, behind: 0, files: {}, ignored: [], truncated: false }
  /** Paths are relative to the repository; those outside the folder are left out. */
  const local = (path: string) => (path.startsWith(prefix) ? path.slice(prefix.length) : null)
  let count = 0
  const add = (path: string, state: GitFileState) => {
    const rel = local(path)
    if (rel === null || rel === '') return
    if (count++ >= MAX_STATUS_PATHS) {
      result.truncated = true
      return
    }
    result.files[rel] = state
  }

  const tokens = status.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.startsWith('# ')) {
      const [key, ...rest] = token.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') result.commit = value === '(initial)' ? null : value.slice(0, 7)
      else if (key === 'branch.head') result.branch = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') result.upstream = value
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match) {
          result.ahead = Number(match[1])
          result.behind = Number(match[2])
        }
      }
      continue
    }
    const kind = token[0]
    if (kind === '1' || kind === '2') {
      // `1 XY sub mH mI mW hH hI path`, renames `2 … Xscore path` with the old path as the next token.
      const fields = splitFields(token, kind === '1' ? 8 : 9)
      if (!fields) continue
      const xy = fields.head[1]!
      if (kind === '2') i++
      add(fields.path, { status: kind === '2' ? 'renamed' : changeOf(xy), staged: xy[0] !== '.', added: null, removed: null })
    } else if (kind === 'u') {
      const fields = splitFields(token, 10)
      if (fields) add(fields.path, { status: 'conflict', staged: false, added: null, removed: null })
    } else if (kind === '?') {
      add(token.slice(2), { status: 'untracked', staged: false, added: null, removed: null })
    } else if (kind === '!') {
      const rel = local(token.slice(2))
      if (rel === null || rel === '') continue
      if (count++ >= MAX_STATUS_PATHS) result.truncated = true
      else result.ignored.push(rel)
    }
  }

  // `added\tremoved\tpath`, for a rename `added\tremoved\t` and then the old and the new path as tokens.
  const lines = numstat.split('\0')
  for (let i = 0; i < lines.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(lines[i]!)
    if (!match) continue
    let path = match[3]!
    if (path === '') {
      path = lines[i + 2] ?? ''
      i += 2
    }
    const rel = local(path)
    const file = rel ? result.files[rel] : undefined
    if (!file) continue
    file.added = match[1] === '-' ? null : Number(match[1])
    file.removed = match[2] === '-' ? null : Number(match[2])
  }
  return result
}

/** The first `count` space-separated fields of a status line and the path after them, which may contain spaces. */
function splitFields(line: string, count: number): { head: string[]; path: string } | null {
  const head: string[] = []
  let start = 0
  for (let n = 0; n < count; n++) {
    const end = line.indexOf(' ', start)
    if (end === -1) return null
    head.push(line.slice(start, end))
    start = end + 1
  }
  return { head, path: line.slice(start) }
}

/** What a change in the index (X) and the work tree (Y) amounts to in the tree. */
function changeOf(xy: string): GitFileStatus {
  if (xy.includes('D')) return 'deleted'
  if (xy[0] === 'A') return 'added'
  return 'modified'
}

/** The touches whose path is a file; each path once. */
async function existingFiles(touches: readonly FileTouch[]): Promise<FileTouch[]> {
  const unique = [...new Map(touches.map((touch) => [touch.path, touch])).values()]
  const found = await Promise.all(
    unique.map((touch) =>
      stat(touch.path).then(
        (info) => (info.isFile() ? touch : null),
        () => null,
      ),
    ),
  )
  return found.filter((touch): touch is FileTouch => touch !== null)
}

/** The paths that are files changed since `since` (ms). */
async function changedFiles(paths: readonly string[], since: number): Promise<string[]> {
  const found = await Promise.all(
    [...new Set(paths)].map((path) =>
      stat(path).then(
        (info) => (info.isFile() && info.mtimeMs >= since ? path : null),
        () => null,
      ),
    ),
  )
  return found.filter((path): path is string => path !== null)
}

/** A change at `path` may be a write of a command running in `cwd`: inside it, not in packages or git's folder. */
export function shellMayWrite(cwd: string, path: string): boolean {
  const rel = relative(cwd, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(/[\\/]/).some((part) => SHELL_SKIPPED.has(part))
}
