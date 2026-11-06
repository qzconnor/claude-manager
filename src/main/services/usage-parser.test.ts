import { describe, expect, it } from 'vitest'
import { parseUsagePayload } from './usage-parser'

const RESET_5H = '2026-11-06T15:00:00.255242+00:00'
const RESET_7D = '2026-11-10T08:00:00+00:00'

describe('parseUsagePayload', () => {
  it('reads the legacy top-level windows', () => {
    const parsed = parseUsagePayload({
      five_hour: { utilization: 42.5, resets_at: RESET_5H },
      seven_day: { utilization: 13, resets_at: RESET_7D },
      seven_day_opus: { utilization: 70, resets_at: RESET_7D },
      seven_day_sonnet: { utilization: 5, resets_at: null },
    })
    expect(parsed?.fiveHour).toEqual({ key: 'five_hour', label: '5-Stunden-Fenster', percent: 42.5, resetsAt: RESET_5H, severity: null })
    expect(parsed?.sevenDay).toEqual({ key: 'seven_day', label: 'Woche · alle Modelle', percent: 13, resetsAt: RESET_7D, severity: null })
    expect(parsed?.scoped).toEqual([
      { key: 'seven_day_opus', label: 'Opus · Woche', percent: 70, resetsAt: RESET_7D, severity: null },
      { key: 'seven_day_sonnet', label: 'Sonnet · Woche', percent: 5, resetsAt: null, severity: null },
    ])
    expect(parsed?.extra).toBeNull()
    expect(parsed?.breakdown).toEqual([])
  })

  it('reads the windows from the limits list', () => {
    const parsed = parseUsagePayload({
      limits: [
        { kind: 'session', percent: 55, severity: 'warning', resets_at: RESET_5H },
        { kind: 'weekly_all', percent: 20, severity: 'normal', resets_at: RESET_7D },
        { kind: 'weekly_opus', percent: 30, resets_at: RESET_7D },
        { kind: 'weekly_cowork', percent: 1 },
        { kind: 'weekly_sonnet', percent: 40, severity: 'critical', scope: { model: { display_name: 'Sonnet 4.5' } } },
        { kind: 'weekly_brand_new_limit', percent: 2 },
      ],
    })
    expect(parsed?.fiveHour).toEqual({ key: 'five_hour', label: '5-Stunden-Fenster', percent: 55, resetsAt: RESET_5H, severity: 'warning' })
    expect(parsed?.sevenDay).toEqual({ key: 'seven_day', label: 'Woche · alle Modelle', percent: 20, resetsAt: RESET_7D, severity: 'normal' })
    expect(parsed?.scoped).toEqual([
      { key: 'weekly_opus', label: 'Opus · Woche', percent: 30, resetsAt: RESET_7D, severity: null },
      { key: 'weekly_cowork', label: 'Cowork · Woche', percent: 1, resetsAt: null, severity: null },
      { key: 'weekly_sonnet:Sonnet 4.5', label: 'Sonnet 4.5 · Woche', percent: 40, resetsAt: null, severity: 'critical' },
      { key: 'weekly_brand_new_limit', label: 'Weekly brand new limit', percent: 2, resetsAt: null, severity: null },
    ])
  })

  it('prefers the legacy values and fills gaps from the limits list', () => {
    const parsed = parseUsagePayload({
      five_hour: { utilization: 0, resets_at: '' },
      seven_day: { utilization: 'n/a' },
      limits: [
        { kind: 'session', percent: 99, severity: 'warning', resets_at: RESET_5H },
        { kind: 'weekly_all', percent: 33, resets_at: RESET_7D },
      ],
    })
    // 0 is a value, not a gap; an empty reset falls back to the limit's.
    expect(parsed?.fiveHour).toMatchObject({ percent: 0, resetsAt: RESET_5H, severity: 'warning' })
    expect(parsed?.sevenDay).toMatchObject({ percent: 33, resetsAt: RESET_7D })
  })

  it('ignores the legacy per-model windows once the limits list has scoped entries', () => {
    const parsed = parseUsagePayload({
      five_hour: { utilization: 10 },
      seven_day_opus: { utilization: 70 },
      limits: [{ kind: 'weekly_sonnet', percent: 40 }],
    })
    expect(parsed?.scoped.map((w) => w.key)).toEqual(['weekly_sonnet'])
  })

  it('falls back to the legacy per-model windows when the limits list only has the main windows', () => {
    const parsed = parseUsagePayload({
      seven_day_sonnet: { utilization: 12 },
      limits: [{ kind: 'session', percent: 10 }],
    })
    expect(parsed?.scoped.map((w) => w.key)).toEqual(['seven_day_sonnet'])
  })

  it('skips malformed limits', () => {
    const parsed = parseUsagePayload({
      five_hour: { utilization: 10 },
      limits: [
        null,
        'session',
        42,
        { kind: 5, percent: 10 },
        { kind: '', percent: 10 },
        { kind: 'weekly_opus' },
        { kind: 'weekly_opus', percent: '50' },
        { kind: 'weekly_opus', percent: Number.NaN },
        { kind: 'weekly_opus', percent: 50, scope: null },
        { kind: 'weekly_sonnet', percent: 60, scope: { model: null } },
        { kind: 'weekly_cowork', percent: 70, scope: { model: { display_name: '' } } },
      ],
    })
    expect(parsed?.scoped.map((w) => `${w.key} ${w.label}`)).toEqual([
      'weekly_opus Opus · Woche',
      'weekly_sonnet Sonnet · Woche',
      'weekly_cowork Cowork · Woche',
    ])
  })

  it('ignores a limits value that is no list', () => {
    expect(parseUsagePayload({ five_hour: { utilization: 1 }, limits: { kind: 'weekly_opus', percent: 5 } })?.scoped).toEqual([])
  })

  it('drops windows without a finite percentage', () => {
    const parsed = parseUsagePayload({
      five_hour: { utilization: Number.POSITIVE_INFINITY },
      seven_day: { utilization: null, resets_at: RESET_7D },
      seven_day_opus: { utilization: 3 },
    })
    expect(parsed?.fiveHour).toBeNull()
    expect(parsed?.sevenDay).toBeNull()
    expect(parsed?.scoped).toHaveLength(1)
  })

  it('keeps values outside 0–100 as they are', () => {
    const parsed = parseUsagePayload({ five_hour: { utilization: 130 }, seven_day: { utilization: -2 } })
    expect(parsed?.fiveHour?.percent).toBe(130)
    expect(parsed?.sevenDay?.percent).toBe(-2)
  })

  it('returns null without any window', () => {
    expect(parseUsagePayload(null)).toBeNull()
    expect(parseUsagePayload(undefined)).toBeNull()
    expect(parseUsagePayload('five_hour')).toBeNull()
    expect(parseUsagePayload(42)).toBeNull()
    expect(parseUsagePayload([])).toBeNull()
    expect(parseUsagePayload({})).toBeNull()
    expect(parseUsagePayload({ five_hour: null, seven_day: null, limits: [] })).toBeNull()
    // Extra usage and the breakdown alone are not enough.
    expect(
      parseUsagePayload({
        extra_usage: { is_enabled: true, used_credits: 100 },
        seven_day_breakdown: { rows: [{ key: 'opus', percent: 5 }] },
      }),
    ).toBeNull()
  })

  describe('extra usage', () => {
    it('scales the credits by the decimal places, two by default', () => {
      const parsed = parseUsagePayload({
        five_hour: { utilization: 1 },
        extra_usage: { is_enabled: true, used_credits: 1234, monthly_limit: 5000, utilization: 24.68, currency: 'USD' },
      })
      expect(parsed?.extra).toEqual({ enabled: true, usedCredits: 12.34, monthlyLimit: 50, percent: 24.68, currency: 'USD' })
    })

    it('uses the given decimal places', () => {
      const parsed = parseUsagePayload({
        five_hour: { utilization: 1 },
        extra_usage: { is_enabled: true, used_credits: 7, monthly_limit: 20, decimal_places: 0 },
      })
      expect(parsed?.extra).toMatchObject({ usedCredits: 7, monthlyLimit: 20 })
    })

    it('keeps missing or odd fields null and only takes a literal true as enabled', () => {
      const parsed = parseUsagePayload({
        five_hour: { utilization: 1 },
        extra_usage: { is_enabled: 'true', used_credits: null, monthly_limit: '5000', utilization: null, currency: '' },
      })
      expect(parsed?.extra).toEqual({ enabled: false, usedCredits: null, monthlyLimit: null, percent: null, currency: null })
    })

    it('is null when the payload has none', () => {
      expect(parseUsagePayload({ five_hour: { utilization: 1 }, extra_usage: null })?.extra).toBeNull()
      expect(parseUsagePayload({ five_hour: { utilization: 1 }, extra_usage: 'on' })?.extra).toBeNull()
    })
  })

  it('reads the breakdown rows, the key standing in for a missing name', () => {
    const parsed = parseUsagePayload({
      five_hour: { utilization: 1 },
      seven_day_breakdown: {
        rows: [
          { key: 'opus', display_name: 'Opus', percent: 60 },
          { key: 'haiku', percent: 0 },
          null,
          'sonnet',
          { key: '', percent: 10 },
          { key: 'sonnet', display_name: 'Sonnet' },
        ],
      },
    })
    expect(parsed?.breakdown).toEqual([
      { key: 'opus', label: 'Opus', percent: 60 },
      { key: 'haiku', label: 'haiku', percent: 0 },
    ])
  })

  it('ignores a breakdown without a rows list', () => {
    expect(parseUsagePayload({ five_hour: { utilization: 1 }, seven_day_breakdown: { rows: {} } })?.breakdown).toEqual([])
    expect(parseUsagePayload({ five_hour: { utilization: 1 }, seven_day_breakdown: null })?.breakdown).toEqual([])
  })
})
