import type { TranscriptMessage } from '@shared/types'

/**
 * A row of a session's history: a message, or the line before the first message of a day. `continued`:
 * the message goes on from the one before it, by the same author a few minutes later, as in a chat;
 * it shows without its head (who wrote it, when).
 */
export type TranscriptRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; key: string; message: TranscriptMessage; continued: boolean }

const DAY_MS = 86_400_000
/** Longest pause after which a message by the same author still goes on from the one before. */
const CONTINUED_MS = 10 * 60_000

/** Who a message is by, as its head says: Claude, the user, or nobody (lines between the messages). */
function authorOf(message: TranscriptMessage): 'claude' | 'user' | null {
  if (message.kind === 'answer') return 'claude'
  return message.kind === 'prompt' || message.kind === 'command' || message.kind === 'shell' ? 'user' : null
}

/** Midnight of the local day of `ms`. */
function startOfDay(ms: number): number {
  const date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** „Heute“, „Gestern“ or the date with its weekday, with the year once it isn't this one. By the calendar day. */
export function dayLabel(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS)
  if (days === 0) return 'Heute'
  if (days === 1) return 'Gestern'
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(ms)
}

/**
 * The messages with a line before each that is from another day than the one before it (the first
 * one too). Messages without a time stay on the day before them.
 */
export function transcriptRows(messages: readonly TranscriptMessage[], now = Date.now()): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let day: number | null = null
  /** The author of the message before and its time (NaN without), since the last line between them. */
  let lastAuthor: 'claude' | 'user' | null = null
  let lastMs = Number.NaN
  for (const message of messages) {
    const ms = message.timestamp ? Date.parse(message.timestamp) : Number.NaN
    if (!Number.isNaN(ms) && startOfDay(ms) !== day) {
      day = startOfDay(ms)
      rows.push({ kind: 'day', key: `day-${day}-${rows.length}`, label: dayLabel(ms, now) })
      lastAuthor = null
    }
    const author = authorOf(message)
    // Without a time it goes on from the message before it as well.
    const pause = Number.isNaN(ms) || Number.isNaN(lastMs) ? 0 : ms - lastMs
    const continued = author !== null && lastAuthor === author && pause <= CONTINUED_MS
    rows.push({ kind: 'message', key: message.uuid, message, continued })
    lastAuthor = author
    if (!Number.isNaN(ms)) lastMs = ms
  }
  return rows
}
