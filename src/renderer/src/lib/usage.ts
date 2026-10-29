import type { UsageWindow } from '@shared/types'

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

/** Name of a limit Claude Code reports (`rateLimitType`). */
export function limitLabel(type: string | null): string {
  switch (type) {
    case 'five_hour':
      return '5-Stunden-Limit'
    case 'seven_day':
      return 'Wochenlimit'
    case 'seven_day_opus':
      return 'Wochenlimit für Opus'
    case 'seven_day_sonnet':
      return 'Wochenlimit für Sonnet'
    default:
      return 'Nutzungslimit'
  }
}

/** A window without reset time and usage hasn't started yet — it begins with the next message. */
export function windowIdle(window: UsageWindow): boolean {
  return !window.resetsAt && clampPercent(window.percent) === 0
}
