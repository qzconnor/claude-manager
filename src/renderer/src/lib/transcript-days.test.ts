import { describe, expect, it } from 'vitest'
import type { TranscriptMessage } from '@shared/types'
import { dayLabel, transcriptRows } from './transcript-days'

// The tests run in Europe/Berlin (vitest.config.ts).
const NOW = new Date(2026, 10, 11, 9, 30).getTime()

const message = (uuid: string, timestamp: string | null): TranscriptMessage => ({
  uuid,
  role: 'user',
  timestamp,
  text: uuid,
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

  it('keeps messages without a time on the day before them', () => {
    const rows = transcriptRows([message('a', null), message('b', new Date(2026, 10, 11, 8).toISOString()), message('c', null)], NOW)
    expect(rows.map((r) => (r.kind === 'day' ? r.label : r.key))).toEqual(['a', 'Heute', 'b', 'c'])
  })
})
