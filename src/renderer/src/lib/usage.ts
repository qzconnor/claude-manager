import type { UsageWindow } from '@shared/types'
import { formatClock, formatDuration } from './format'

export { limitLabel } from '@shared/utils'

/** Green below 60 %, orange from 60 %, red from 85 %. */
export type UsageLevel = 'low' | 'medium' | 'high'

export function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)))
}

export function usageLevel(percent: number): UsageLevel {
  return percent >= 85 ? 'high' : percent >= 60 ? 'medium' : 'low'
}

/** Text in the color of the level (full class names, so Tailwind finds them). */
export const usageTextClass: Record<UsageLevel, string> = {
  low: 'text-usage-low',
  medium: 'text-usage-medium',
  high: 'text-usage-high',
}

/** Fill of a `Progress` bar in the color of the level. */
export const usageFillClass: Record<UsageLevel, string> = {
  low: '*:data-[slot=progress-indicator]:bg-usage-low',
  medium: '*:data-[slot=progress-indicator]:bg-usage-medium',
  high: '*:data-[slot=progress-indicator]:bg-usage-high',
}

/** A window without reset time and usage hasn't started yet — it begins with the next message. */
export function windowIdle(window: UsageWindow): boolean {
  return !window.resetsAt && clampPercent(window.percent) === 0
}

/** What the forecast of a window says, short for the meter and in full for its tooltip. */
export interface ForecastHint {
  text: string
  title: string
  /** The limit comes before the reset. */
  warn: boolean
  /** When the limit comes, as a clock time; null when it doesn't come before the reset. */
  at: string | null
}

function rateLabel(hours: number): string {
  const rounded = Math.round(hours * 10) / 10
  return `${rounded.toLocaleString('de')} ${rounded === 1 ? 'Punkt' : 'Punkte'} pro Stunde`
}

/**
 * Where the window heads at the current pace: when the limit comes, if before the reset, otherwise
 * how full it will be at the reset. Null while there is nothing to tell, or nothing more will be used.
 */
export function forecastHint(window: UsageWindow, now: number): ForecastHint | null {
  const forecast = window.forecast
  if (!forecast || windowIdle(window)) return null
  const basis = forecast.basis === 'recent' ? 'Tempo der letzten Zeit' : 'Schnitt seit Beginn des Fensters'
  if (forecast.exhaustsAt) {
    if (Date.parse(forecast.exhaustsAt) <= now) return null
    const at = formatClock(forecast.exhaustsAt, now)
    const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN
    const early = Number.isNaN(reset) ? '' : `, ${formatDuration(reset - Date.parse(forecast.exhaustsAt))} vor dem Reset`
    return {
      text: `Limit ≈ ${at}`,
      title: `Bei diesem Tempo (${rateLabel(forecast.ratePerHour)}, ${basis}) ist das Limit gegen ${at} erreicht${early}.`,
      warn: true,
      at,
    }
  }
  const atReset = Math.min(100, Math.round(forecast.atReset))
  if (atReset <= clampPercent(window.percent)) return null
  return {
    text: `≈ ${atReset} % zum Reset`,
    title: `Bei diesem Tempo (${rateLabel(forecast.ratePerHour)}, ${basis}) steht das Fenster zum Reset bei etwa ${atReset} %.`,
    warn: false,
    at: null,
  }
}
