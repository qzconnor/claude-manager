import type { TranscriptMessage } from '@shared/types'

/** A row of a session's history: a message, or the line before the first message of a day. */
export type TranscriptRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; key: string; message: TranscriptMessage }

const DAY_MS = 86_400_000

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
  for (const message of messages) {
    const ms = message.timestamp ? Date.parse(message.timestamp) : Number.NaN
    if (!Number.isNaN(ms) && startOfDay(ms) !== day) {
      day = startOfDay(ms)
      rows.push({ kind: 'day', key: `day-${day}-${rows.length}`, label: dayLabel(ms, now) })
    }
    rows.push({ kind: 'message', key: message.uuid, message })
  }
  return rows
}
