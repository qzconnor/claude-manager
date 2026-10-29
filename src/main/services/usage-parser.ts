import type { AccountUsage, ExtraUsage, UsageWindow } from '@shared/types'

/**
 * Parses the payload of `GET https://api.anthropic.com/api/oauth/usage`.
 * Claude Code stores the very same payload as `cachedUsageUtilization.utilization`
 * in its global config, so both sources share this parser.
 */

interface RawWindow {
  utilization?: unknown
  resets_at?: unknown
}

interface RawLimit {
  kind?: unknown
  percent?: unknown
  severity?: unknown
  resets_at?: unknown
  scope?: { model?: { display_name?: unknown } | null } | null
}

type ParsedUsage = Pick<AccountUsage, 'fiveHour' | 'sevenDay' | 'scoped' | 'extra' | 'breakdown'>

const KIND_LABELS: Record<string, string> = {
  weekly_opus: 'Opus · Woche',
  weekly_sonnet: 'Sonnet · Woche',
  weekly_oauth_apps: 'OAuth-Apps · Woche',
  weekly_cowork: 'Cowork · Woche',
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toWindow(key: string, label: string, legacy: RawWindow | undefined, limit: RawLimit | undefined): UsageWindow | null {
  const percent = num(legacy?.utilization) ?? num(limit?.percent)
  if (percent === null) return null
  return {
    key,
    label,
    percent,
    resetsAt: str(legacy?.resets_at) ?? str(limit?.resets_at),
    severity: str(limit?.severity),
  }
}

function humanizeKind(kind: string): string {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind]
  const text = kind.replace(/_/g, ' ').trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function parseUsagePayload(raw: unknown): ParsedUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const limits: RawLimit[] = Array.isArray(data.limits) ? (data.limits.filter((l) => l && typeof l === 'object') as RawLimit[]) : []
  const sessionLimit = limits.find((l) => l.kind === 'session')
  const weeklyLimit = limits.find((l) => l.kind === 'weekly_all')

  const fiveHour = toWindow('five_hour', '5-Stunden-Fenster', data.five_hour as RawWindow | undefined, sessionLimit)
  const sevenDay = toWindow('seven_day', 'Woche · alle Modelle', data.seven_day as RawWindow | undefined, weeklyLimit)

  const scoped: UsageWindow[] = []
  for (const limit of limits) {
    const kind = str(limit.kind)
    const percent = num(limit.percent)
    if (!kind || percent === null || kind === 'session' || kind === 'weekly_all') continue
    const model = str(limit.scope?.model?.display_name)
    scoped.push({
      key: model ? `${kind}:${model}` : kind,
      label: model ? `${model} · Woche` : humanizeKind(kind),
      percent,
      resetsAt: str(limit.resets_at),
      severity: str(limit.severity),
    })
  }
  if (scoped.length === 0) {
    // Older payloads only carry the per-model weekly windows as top-level keys.
    for (const [key, label] of [
      ['seven_day_opus', 'Opus · Woche'],
      ['seven_day_sonnet', 'Sonnet · Woche'],
    ] as const) {
      const window = toWindow(key, label, data[key] as RawWindow | undefined, undefined)
      if (window) scoped.push(window)
    }
  }

  let extra: ExtraUsage | null = null
  const rawExtra = data.extra_usage as Record<string, unknown> | null | undefined
  if (rawExtra && typeof rawExtra === 'object') {
    const decimals = num(rawExtra.decimal_places) ?? 2
    const scale = 10 ** decimals
    const used = num(rawExtra.used_credits)
    const limit = num(rawExtra.monthly_limit)
    extra = {
      enabled: rawExtra.is_enabled === true,
      usedCredits: used === null ? null : used / scale,
      monthlyLimit: limit === null ? null : limit / scale,
      percent: num(rawExtra.utilization),
      currency: str(rawExtra.currency),
    }
  }

  const breakdown: AccountUsage['breakdown'] = []
  const rows = (data.seven_day_breakdown as { rows?: unknown } | null | undefined)?.rows
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const key = str(r.key)
      const percent = num(r.percent)
      if (!key || percent === null) continue
      breakdown.push({ key, label: str(r.display_name) ?? key, percent })
    }
  }

  if (!fiveHour && !sevenDay && scoped.length === 0) return null
  return { fiveHour, sevenDay, scoped, extra, breakdown }
}
