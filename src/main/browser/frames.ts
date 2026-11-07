import { FRAME_MARK } from './page-scripts'

/**
 * Frames of other sites in a page Claude drives (payment forms, captchas, embeds). The page's scripts
 * can't reach into them, so the page driver reads them through the DevTools protocol: in a script
 * world of their own in each frame, which it creates with `Page.createIsolatedWorld`. A frame that
 * runs in a process of its own (site isolation) has a DevTools session of its own, which Chromium
 * attaches by itself (`Target.setAutoAttach`). Refs of elements in such a frame carry its number:
 * `f2e5` is `e5` in frame 2.
 */

/** A frame of another site the page driver knows, by its number (the `f` of its refs). */
export interface FrameRecord {
  num: number
  frameId: string
  /** The DevTools session the frame is reached by: its own in a process of its own, else its parent's. */
  session: string | undefined
  /** The frame it sits in; null: the page itself. */
  parent: number | null
  /** The ref of its iframe element in that frame. */
  ownerRef: string
  /** Its script world, until its document changes. */
  contextId: number | null
}

/** A line of a snapshot that stands for a frame of another site: indentation and the iframe's ref. */
export const FRAME_MARK_RE = new RegExp(`^( *)- ${FRAME_MARK}(e\\d+)$`, 'gm')
const FRAME_REF_RE = /^f(\d{1,6})(e\d{1,9})$/

/** Frames inside frames inside frames are read; deeper ones are named only. */
export const MAX_FRAME_DEPTH = 3

/** A ref as the tools take it: in the page (`e12`) or in one of its frames (`f2e5`). */
export function parseRef(ref: string): { frame: number | null; local: string } {
  const match = FRAME_REF_RE.exec(ref)
  return match ? { frame: Number(match[1]), local: match[2] } : { frame: null, local: ref }
}

export function isFrameRef(ref: string): boolean {
  return FRAME_REF_RE.test(ref)
}

/** The refs of a frame's snapshot as the page's refs: `e5` becomes `f2e5` (those of deeper frames have theirs). */
export function prefixRefs(text: string, frame: number): string {
  return text.replace(/\[ref=(e\d+)\]/g, `[ref=f${frame}$1]`)
}

/** A frame's snapshot in the place of its mark, one level below its iframe. */
export function indentLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => indent + line)
    .join('\n')
}

/** What the page's scripts report about an element of a frame, with the page's refs. */
export function frameError(message: string, frame: number): string {
  return message.replace(/\bElement (e\d+)\b/g, `Element f${frame}$1`)
}

/** The frames of other sites of one browser, and the DevTools sessions of those in processes of their own. */
export class PageFrames {
  private readonly records = new Map<number, FrameRecord>()
  private readonly byFrameId = new Map<string, number>()
  /** Frame id → DevTools session, for frames in a process of their own. */
  private readonly sessions = new Map<string, string>()
  /** Numbers go on across documents: an old ref never points into another frame. */
  private next = 1
  private doc: string | null = null

  /** The page's document of the last snapshot; another one has other frames. */
  setDocument(doc: string): void {
    if (doc === this.doc) return
    this.doc = doc
    this.records.clear()
    this.byFrameId.clear()
  }

  /** Chromium attached a session to a frame in a process of its own. */
  attached(frameId: string, session: string): void {
    this.sessions.set(frameId, session)
  }

  detached(session: string): void {
    for (const [frameId, known] of this.sessions) if (known === session) this.sessions.delete(frameId)
    for (const record of this.records.values()) if (record.session === session) record.contextId = null
  }

  /** All sessions of frames in processes of their own, e.g. to emulate a slow network in them too. */
  frameSessions(): string[] {
    return [...this.sessions.values()]
  }

  /** The session a frame is reached by: its own, or that of the frame it sits in. */
  sessionFor(frameId: string, parentSession: string | undefined): string | undefined {
    return this.sessions.get(frameId) ?? parentSession
  }

  /** The record of a frame found in a snapshot; it keeps its number while the page's document stays. */
  record(frameId: string, parent: FrameRecord | null, ownerRef: string): FrameRecord {
    const session = this.sessionFor(frameId, parent?.session)
    const known = this.byFrameId.get(frameId)
    const existing = known === undefined ? undefined : this.records.get(known)
    if (existing) {
      if (existing.session !== session) existing.contextId = null
      existing.session = session
      existing.parent = parent?.num ?? null
      existing.ownerRef = ownerRef
      return existing
    }
    const record: FrameRecord = { num: this.next++, frameId, session, parent: parent?.num ?? null, ownerRef, contextId: null }
    this.records.set(record.num, record)
    this.byFrameId.set(frameId, record.num)
    return record
  }

  get(num: number): FrameRecord | undefined {
    return this.records.get(num)
  }

  all(): FrameRecord[] {
    return [...this.records.values()]
  }
}
