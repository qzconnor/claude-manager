import type { SessionContext } from '@shared/types'
import { clampPercent } from './usage'

export { modelName } from '@shared/model-name'

/** How far a session's context is on its way to the next auto-compact (or to the full window without one). */
export interface ContextGauge {
  /** Where the gauge ends: where Claude Code compacts, or the window when it doesn't. */
  limit: number
  /** 0–100 of `limit`. */
  percent: number
  /** Tokens left until `limit`. */
  left: number
  /** Room Claude Code keeps below the window for the answer and the summary; 0 without auto-compact. */
  buffer: number
}

/** Before the first answer the gauge is empty. */
export function contextGauge(context: SessionContext): ContextGauge {
  const limit = Math.max(1, context.compactAt ?? context.window)
  const tokens = context.tokens ?? 0
  return {
    limit,
    percent: clampPercent((tokens / limit) * 100),
    left: Math.max(0, limit - tokens),
    buffer: context.compactAt === null ? 0 : Math.max(0, context.window - context.compactAt),
  }
}

/** Tokens short, as Claude Code writes them: `850`, `136k`, `1M`, `1,2M`. */
export function shortTokens(value: number): string {
  if (value >= 1_000_000) return `${(Math.round(value / 100_000) / 10).toLocaleString('de')}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(Math.max(0, Math.round(value)))
}
