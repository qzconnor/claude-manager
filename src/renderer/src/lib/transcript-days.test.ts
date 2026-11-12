import { describe, expect, it } from 'vitest'
import type { TranscriptMessage } from '@shared/types'
import { dayLabel, transcriptRows } from './transcript-days'

// The tests run in Europe/Berlin (vitest.config.ts).
const NOW = new Date(2026, 10, 11, 9, 30).getTime()

const message = (uuid: string, timestamp: string | null): TranscriptMessage => ({
  uuid,
  role: 'user',
  kind: 'prompt',
  timestamp,
  text: uuid,
  output: null,
  failed: false,
  tools: [],
  model: null,
})

describe('dayLabel', () => {
  it('says today and yesterday by the calendar day', () => {
    expect(dayLabel(new Date(2026, 10, 11, 0, 5).getTime(), NOW)).toBe('Heute')
    expect(dayLabel(new Date(2026, 10, 10, 23, 55).getTime(), NOW)).toBe('Gestern')
  })

  it('names other days with their weekday, and the year when it is another', () => {
    expect(dayLabel(new Date(2026, 10, 9, 12).getTime(), NOW)).toBe('Montag, 9. November')
    expect(dayLabel(new Date(2025, 11, 31, 12).getTime(), NOW)).toBe('Mittwoch, 31. Dezember 2025')
  })
})

describe('transcriptRows', () => {
  it('puts a line before the first message of each day', () => {
    const rows = transcriptRows(
      [
        message('a', new Date(2026, 10, 9, 22).toISOString()),
        message('b', new Date(2026, 10, 9, 23).toISOString()),
        message('c', new Date(2026, 10, 10, 8).toISOString()),
        message('d', new Date(2026, 10, 11, 9).toISOString()),
      ],
      NOW,
    )
    expect(rows.map((r) => (r.kind === 'day' ? r.label : r.key))).toEqual(['Montag, 9. November', 'a', 'b', 'Gestern', 'c', 'Heute', 'd'])
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })

  it('lets messages by the same author a few minutes apart go on from the one before, as in a chat', () => {
    const at = (minute: number) => new Date(2026, 10, 11, 9, minute).toISOString()
    const said = (uuid: string, kind: TranscriptMessage['kind'], minute: number | null): TranscriptMessage => ({
      ...message(uuid, minute === null ? null : at(minute)),
      role: kind === 'answer' ? 'assistant' : 'user',
      kind,
    })
    const rows = transcriptRows(
      [
        said('p1', 'prompt', 0),
        said('c1', 'command', 1),
        said('a1', 'answer', 1),
        said('a2', 'answer', 5),
        said('a3', 'answer', null),
        said('a4', 'answer', 16),
        said('t1', 'task', 16),
        said('a5', 'answer', 17),
        said('s1', 'summary', 18),
        said('s2', 'summary', 18),
      ],
      NOW,
    )
    const continued = rows.flatMap((r) => (r.kind === 'message' && r.continued ? [r.key] : []))
    // a4 comes 11 minutes after a2, a task breaks a run, lines between messages never go on.
    expect(continued).toEqual(['c1', 'a2', 'a3'])
  })

  it('starts each day with the head of its first message', () => {
    const rows = transcriptRows(
      [
        { ...message('a', new Date(2026, 10, 10, 23, 58).toISOString()), role: 'assistant', kind: 'answer' },
        { ...message('b', new Date(2026, 10, 11, 0, 1).toISOString()), role: 'assistant', kind: 'answer' },
      ],
      NOW,
    )
    expect(rows.filter((r) => r.kind === 'message').map((r) => r.kind === 'message' && r.continued)).toEqual([false, false])
  })

  it('keeps messages without a time on the day before them', () => {
    const rows = transcriptRows([message('a', null), message('b', new Date(2026, 10, 11, 8).toISOString()), message('c', null)], NOW)
    expect(rows.map((r) => (r.kind === 'day' ? r.label : r.key))).toEqual(['a', 'Heute', 'b', 'c'])
  })
})
