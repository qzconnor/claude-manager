import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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

/** `mode`: the file's permissions on macOS and Linux, e.g. 0o600 for a file only its user may read. */
export interface WriteJsonOptions {
  mode?: number
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
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: options.mode })
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

async function writeNow(file: string, content: string, options: WriteJsonOptions): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, content, { encoding: 'utf8', mode: options.mode })
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
