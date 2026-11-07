import type { TerminalInfo } from '@shared/types'
import type { AccountService } from '../../services/account-service'
import type { SessionService } from '../../services/session-service'
import type { SettingsService } from '../../services/settings-service'
import type { TerminalService } from '../../services/terminal-service'
import type { UsageService } from '../../services/usage-service'
import type { Args } from '../tool-args'
import type { Shells } from './shells'

/** How an app tool is made, what it works with, and how times read in its answers. */

/** The switches of the settings the tools belong to. */
export type AppToolGroup = 'limits' | 'sessions' | 'shell'

export interface AppToolDefinition<P> {
  name: string
  title: string
  description: string
  properties: Record<string, unknown>
  required?: string[]
  group: AppToolGroup
  readOnly?: boolean
  destructive?: boolean
  parse(args: Args): P
  run(app: AppToolContext, session: TerminalInfo, params: P): Promise<string>
}

export function tool<P>(definition: AppToolDefinition<P>): AppToolDefinition<never> {
  return definition as unknown as AppToolDefinition<never>
}

export interface AppToolsDeps {
  terminals: TerminalService
  usage: UsageService
  sessions: SessionService
  accounts: AccountService
  settings: SettingsService
}

/** What a tool works with: the app's services and the shells the sessions opened. */
export interface AppToolContext {
  deps: AppToolsDeps
  shells: Shells
}

/** A time for Claude: local date and time. */
export function localTime(iso: string | null, now?: number): string {
  if (!iso) return 'unknown'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'unknown'
  const pad = (n: number) => String(n).padStart(2, '0')
  const text = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return now === undefined ? text : `${text} (${relative(date.getTime() - now)})`
}

/** "in 1 h 40 min", "3 min ago". */
export function relative(ms: number): string {
  const past = ms < 0
  const minutes = Math.round(Math.abs(ms) / 60_000)
  if (minutes < 1) return 'now'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const span = days > 0 ? `${days} d${hours ? ` ${hours} h` : ''}` : hours > 0 ? `${hours} h${mins ? ` ${mins} min` : ''}` : `${mins} min`
  return past ? `${span} ago` : `in ${span}`
}
