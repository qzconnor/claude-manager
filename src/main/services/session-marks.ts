import { join } from 'node:path'
import { cleanTags } from '@shared/session-marks'
import { readJsonGuardedSync, writeJsonAtomic } from '../lib/json-file'
import { SESSION_ID_RE } from '../lib/session-files'
import { TypedEmitter } from '../lib/typed-emitter'

/** What the user marked a session with in the app. */
export interface SessionMark {
  pinned: boolean
  tags: string[]
}

interface MarksFile {
  /** By session id: the id stays when a session goes on with another account. */
  marks: Record<string, { pinned?: boolean; tags?: string[] }>
}

type Events = {
  /** The session was pinned, unpinned or got other tags. */
  changed: [sessionId: string]
}

const UNMARKED: SessionMark = { pinned: false, tags: [] }

/**
 * Pins and tags the user gave sessions in the app, in `session-marks.json` in the app's data folder:
 * kept apart from the transcripts, which are Claude Code's. A session without either has no entry.
 */
export class SessionMarks extends TypedEmitter<Events> {
  private readonly file: string
  private marks = new Map<string, SessionMark>()

  constructor(userDataDir: string) {
    super()
    this.file = join(userDataDir, 'session-marks.json')
  }

  init(): void {
    const data = readJsonGuardedSync<Partial<MarksFile>>(this.file)
    const marks = data?.marks && typeof data.marks === 'object' ? data.marks : {}
    for (const [id, mark] of Object.entries(marks)) {
      if (!SESSION_ID_RE.test(id) || !mark || typeof mark !== 'object') continue
      const next = { pinned: mark.pinned === true, tags: Array.isArray(mark.tags) ? cleanTags(mark.tags) : [] }
      if (next.pinned || next.tags.length) this.marks.set(id.toLowerCase(), next)
    }
  }

  get(sessionId: string): SessionMark {
    return this.marks.get(sessionId.toLowerCase()) ?? UNMARKED
  }

  /** Pins the session or takes the pin away. */
  setPinned(sessionId: string, pinned: boolean): void {
    this.update(sessionId, { ...this.get(sessionId), pinned })
  }

  /** Gives the session these tags (cleaned, each once); none takes them all away. */
  setTags(sessionId: string, tags: readonly unknown[]): void {
    this.update(sessionId, { ...this.get(sessionId), tags: cleanTags(tags) })
  }

  private update(sessionId: string, next: SessionMark): void {
    if (!SESSION_ID_RE.test(sessionId)) throw new Error('Ungültige Session-ID.')
    const id = sessionId.toLowerCase()
    const before = this.get(id)
    if (before.pinned === next.pinned && before.tags.join('\n') === next.tags.join('\n')) return
    if (next.pinned || next.tags.length) this.marks.set(id, next)
    else this.marks.delete(id)
    const file: MarksFile = {
      marks: Object.fromEntries(
        [...this.marks].map(([key, mark]) => [key, { ...(mark.pinned && { pinned: true }), ...(mark.tags.length && { tags: mark.tags }) }]),
      ),
    }
    void writeJsonAtomic(this.file, file, { guarded: true }).catch((error) => console.warn('[session-marks] could not be saved', error))
    this.emit('changed', sessionId)
  }
}
