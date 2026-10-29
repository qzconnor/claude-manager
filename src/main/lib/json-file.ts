import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
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

/**
 * Writes JSON atomically (temp file + rename). Writes to the same file are serialized,
 * so concurrent callers can never interleave or lose the newest content.
 */
export function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const previous = writeQueues.get(file) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() => writeNow(file, `${JSON.stringify(data, null, 2)}\n`))
  writeQueues.set(file, next)
  void next.finally(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file)
  })
  return next
}

async function writeNow(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, content, 'utf8')
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
