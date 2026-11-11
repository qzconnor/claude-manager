import { randomBytes } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

/** Reads and parses a JSON file. Returns `null` when the file is missing or invalid. */
export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(stripBom(await readFile(file, 'utf8'))) as T
  } catch {
    return null
  }
}

export function readJsonSync<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(stripBom(readFileSync(file, 'utf8'))) as T
  } catch {
    return null
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

const writeQueues = new Map<string, Promise<void>>()

/**
 * `mode`: the file's permissions on macOS and Linux, e.g. 0o600 for a file only its user may read.
 * `guarded`: a file the app can't rebuild, read with `readJsonGuarded`: its previous version is kept as
 * `<file>.bak`, and it isn't written while it couldn't be read at the start (its content would be lost).
 */
export interface WriteJsonOptions {
  mode?: number
  guarded?: boolean
}

/**
 * Writes JSON atomically (temp file + rename). Writes to the same file are serialized,
 * so concurrent callers can never interleave or lose the newest content.
 */
export function writeJsonAtomic(file: string, data: unknown, options: WriteJsonOptions = {}): Promise<void> {
  const previous = writeQueues.get(file) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() => writeNow(file, `${JSON.stringify(data, null, 2)}\n`, options))
  writeQueues.set(file, next)
  // Cleans up on success and failure; a failure reaches only the caller, not as an unhandled rejection.
  const forget = () => {
    if (writeQueues.get(file) === next) writeQueues.delete(file)
  }
  void next.then(forget, forget)
  return next
}

/**
 * Blocking variant of `writeJsonAtomic` for small files that have to be on disk right away,
 * e.g. state that must survive quitting the app at any moment.
 */
export function writeJsonAtomicSync(file: string, data: unknown, options: WriteJsonOptions = {}): void {
  if (options.guarded) refuseUnread(file)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  // On the disk before the rename: after a power cut the file is the old or the new one, never empty.
  const fd = openSync(tmp, 'w', options.mode)
  try {
    writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    if (options.guarded) keepBackupSync(file)
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

async function writeNow(file: string, content: string, options: WriteJsonOptions): Promise<void> {
  if (options.guarded) refuseUnread(file)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  // On the disk before the rename: after a power cut the file is the old or the new one, never empty.
  const handle = await open(tmp, 'w', options.mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (options.guarded) await keepBackup(file)
  // Windows can briefly lock the target (antivirus, indexer) — retry a few times.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file)
      return
    } catch (error) {
      if (attempt >= 5) {
        await rm(tmp, { force: true })
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

// Files the app can't rebuild (accounts, settings …): `readJson` takes a broken or locked file for a
// missing one, and the next write would replace it with an empty state. These functions don't.

/** What happened to a guarded file when it was read, for the user. */
export interface JsonProblem {
  file: string
  message: string
}

const problems: JsonProblem[] = []
/** Guarded files that were there but couldn't be read: not written until the next start. */
const unread = new Set<string>()

const READ_ATTEMPTS = 6

/**
 * Reads a file the app can't rebuild. Missing: `null`. Broken (e.g. empty after a power cut): it is
 * moved aside as `<file>.broken-<time>` and its last good version (`<file>.bak`) comes back, else
 * `null`. Locked for longer (antivirus, sync tools): read again a few times, then `null`, and
 * `writeJsonAtomic` with `guarded` refuses to replace it until the next start. Each case but a
 * missing file leaves a message for `takeJsonProblems`.
 */
export async function readJsonGuarded<T>(file: string): Promise<T | null> {
  for (let attempt = 1; ; attempt++) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      if (attempt >= READ_ATTEMPTS) return markUnread(file, error)
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
      continue
    }
    return parseGuarded<T>(file, text)
  }
}

/** `readJsonGuarded` for services that read their file in their constructor. */
export function readJsonGuardedSync<T>(file: string): T | null {
  for (let attempt = 1; ; attempt++) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      if (attempt >= READ_ATTEMPTS) return markUnread(file, error)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt)
      continue
    }
    return parseGuarded<T>(file, text)
  }
}

/** The messages about guarded files read so far, each only once. */
export function takeJsonProblems(): JsonProblem[] {
  return problems.splice(0)
}

function parseGuarded<T>(file: string, text: string): T | null {
  try {
    return JSON.parse(stripBom(text)) as T
  } catch {
    // Broken, see below.
  }
  const name = basename(file)
  const aside = `${file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`
  let moved = false
  try {
    renameSync(file, aside)
    moved = true
  } catch {
    // Can't be moved aside: it stays, and isn't replaced either.
    unread.add(file)
  }
  const keptAside = moved ? ` Die beschädigte Datei liegt als „${basename(aside)}“ daneben.` : ''
  const backup = readJsonSync<T>(`${file}.bak`)
  if (backup !== null) {
    try {
      if (moved) copyFileSync(`${file}.bak`, file)
    } catch {
      // Written again with the next change.
    }
    problems.push({ file, message: `„${name}“ war beschädigt. Die App hat die letzte funktionierende Fassung geladen.${keptAside}` })
    return backup
  }
  problems.push({ file, message: `„${name}“ war beschädigt, und es gibt keine frühere Fassung.${keptAside} Die App startet ohne ihren Inhalt.` })
  return null
}

function markUnread(file: string, error: unknown): null {
  unread.add(file)
  const code = (error as NodeJS.ErrnoException | null)?.code
  problems.push({
    file,
    message: `„${basename(file)}“ ließ sich nicht lesen${code ? ` (${code})` : ''}. Damit ihr Inhalt nicht verloren geht, speichert die App Änderungen daran erst nach einem Neustart.`,
  })
  return null
}

function refuseUnread(file: string): void {
  if (unread.has(file)) {
    throw new Error(
      `„${basename(file)}“ ließ sich beim Start nicht lesen. Damit ihr Inhalt nicht verloren geht, speichert die App Änderungen daran erst nach einem Neustart.`,
    )
  }
}

/** Keeps the current file as `<file>.bak` before it is replaced, if it is valid JSON. */
async function keepBackup(file: string): Promise<void> {
  try {
    JSON.parse(stripBom(await readFile(file, 'utf8')))
    await copyFile(file, `${file}.bak`)
  } catch {
    // Nothing (valid) to keep.
  }
}

function keepBackupSync(file: string): void {
  try {
    JSON.parse(stripBom(readFileSync(file, 'utf8')))
    copyFileSync(file, `${file}.bak`)
  } catch {
    // Nothing (valid) to keep.
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}
