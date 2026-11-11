import { join } from 'node:path'
import { readJsonSync, writeJsonAtomic } from '../lib/json-file'
import { SESSION_ID_RE } from '../lib/session-files'
import { TypedEmitter } from '../lib/typed-emitter'

/** A name is shown in one line: like a tab title, at most this long. */
export const MAX_SESSION_NAME_LENGTH = 120

interface NamesFile {
  /** By session id: the id stays when a session goes on with another account. */
  names: Record<string, string>
}

type Events = {
  /** The session got a name, another one, or (`null`) lost it and shows Claude Code's title again. */
  changed: [sessionId: string, name: string | null]
}

/** On one line and not longer than a tab title; empty for nothing but spaces. */
export function cleanSessionName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_SESSION_NAME_LENGTH)
}

/**
 * The names the user gave sessions in the app (by renaming a tab or a session in the list), in
 * `session-names.json` in the app's data folder. A name counts over the title Claude Code gives the
 * session, also one it generates again later, everywhere in the app: tab, session list, search and API.
 * Kept apart from the transcript: Claude Code writes its own title there again after every turn.
 */
export class SessionNames extends TypedEmitter<Events> {
  private readonly file: string
  private names = new Map<string, string>()

  constructor(userDataDir: string) {
    super()
    this.file = join(userDataDir, 'session-names.json')
  }

  init(): void {
    const data = readJsonSync<Partial<NamesFile>>(this.file)
    const names = data?.names && typeof data.names === 'object' ? data.names : {}
    for (const [id, name] of Object.entries(names)) {
      const clean = typeof name === 'string' ? cleanSessionName(name) : ''
      if (SESSION_ID_RE.test(id) && clean) this.names.set(id.toLowerCase(), clean)
    }
  }

  /** The session's name; null when it has none and shows Claude Code's title. */
  get(sessionId: string): string | null {
    return this.names.get(sessionId.toLowerCase()) ?? null
  }

  /** Names the session; an empty name (or null) takes its name away again. */
  set(sessionId: string, name: string | null): void {
    if (!SESSION_ID_RE.test(sessionId)) throw new Error('Ungültige Session-ID.')
    const id = sessionId.toLowerCase()
    const next = cleanSessionName(name ?? '') || null
    if ((this.names.get(id) ?? null) === next) return
    if (next) this.names.set(id, next)
    else this.names.delete(id)
    void writeJsonAtomic(this.file, { names: Object.fromEntries(this.names) } satisfies NamesFile).catch((error) =>
      console.warn('[session-names] could not be saved', error),
    )
    this.emit('changed', sessionId, next)
  }
}
