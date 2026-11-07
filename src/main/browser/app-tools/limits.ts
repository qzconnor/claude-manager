import type { Account, AccountUsage, TerminalInfo, UsageWindow } from '@shared/types'
import { type AppToolDefinition, type AppToolsDeps, localTime, tool } from './tool'

/** The tool `limits`: the usage limits of the session's account and of the others. */

export const limitsTools: AppToolDefinition<never>[] = [
  tool({
    name: 'limits',
    title: 'Usage limits',
    description:
      'The usage limits of the Claude account this session runs on: how much of the 5-hour window and of the weekly limits is used, and when they reset. Also the other accounts in Claude Manager. Check it before long tasks.',
    properties: {},
    group: 'limits',
    readOnly: true,
    parse: () => ({}),
    run: async (app, session) => limitsReport(app.deps, session),
  }),
]

/** The limits of the account the session runs on, and of the other accounts. */
export function limitsReport(deps: AppToolsDeps, session: TerminalInfo): string {
  const accounts = deps.accounts.list()
  const usage = deps.usage.getAll()
  const accountId = session.authAccountId || session.accountId
  return formatLimits({
    account: accounts.find((a) => a.id === accountId) ?? null,
    filesAccount: session.authAccountId && session.authAccountId !== session.accountId ? (accounts.find((a) => a.id === session.accountId) ?? null) : null,
    usage: usage.find((u) => u.accountId === accountId) ?? null,
    others: accounts.filter((a) => a.id !== accountId).map((a) => ({ account: a, usage: usage.find((u) => u.accountId === a.id) ?? null })),
    sessionLimit: session.limit,
    autoSwitch: deps.settings.get().claude.autoSwitch,
    now: Date.now(),
  })
}

/** An English name for a limit window (the app's labels are German). */
export function windowName(window: UsageWindow): string {
  if (window.key === 'five_hour') return '5-hour window'
  if (window.key === 'seven_day') return 'Week, all models'
  if (window.key === 'seven_day_opus') return 'Week, Opus'
  if (window.key === 'seven_day_sonnet') return 'Week, Sonnet'
  const [kind, model] = window.key.split(':')
  if (model) return /week/i.test(kind) ? `Week, ${model}` : `${kind.replace(/_/g, ' ')}, ${model}`
  return window.label
}

/** Where the window heads at the current pace, as a tail for its line; empty while that can't be told. */
function forecastText(window: UsageWindow, now: number): string {
  const forecast = window.forecast
  if (!forecast) return ''
  if (forecast.exhaustsAt && Date.parse(forecast.exhaustsAt) > now) {
    return `; at the current pace (${forecast.ratePerHour} points/hour) it reaches 100 % ${localTime(forecast.exhaustsAt, now)}, before the reset`
  }
  if (forecast.exhaustsAt) return ''
  return `; at the current pace about ${Math.round(forecast.atReset)} % by the reset`
}

export interface LimitsInput {
  account: Account | null
  /** The account whose files the session uses, when its limits come from another one. */
  filesAccount: Account | null
  usage: AccountUsage | null
  others: { account: Account; usage: AccountUsage | null }[]
  sessionLimit: TerminalInfo['limit']
  autoSwitch: boolean
  now: number
}

const SOURCES: Record<AccountUsage['source'], string> = {
  live: 'live from Anthropic',
  'claude-cache': "from Claude Code's cache",
  none: 'no numbers yet',
}

export function formatLimits(input: LimitsInput): string {
  const { account, usage, now } = input
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const name = account?.name ?? 'unknown account'
  const lines: string[] = []
  const borrowed = input.filesAccount ? ` (its files are those of ${input.filesAccount.name})` : ''
  lines.push(`This session runs on the account ${JSON.stringify(name)}${borrowed}. Times are local (${zone}).`)
  if (input.sessionLimit) {
    const reset = input.sessionLimit.resetsAt ? `, resets ${localTime(input.sessionLimit.resetsAt, now)}` : ''
    lines.push(`This session is stopped at a usage limit right now${reset}: ${input.sessionLimit.message}`)
  }
  if (!usage) {
    lines.push('Claude Manager has no usage numbers for it.')
  } else {
    if (usage.status !== 'ok') lines.push(`Status: ${usage.status}${usage.message ? ` (${usage.message})` : ''}.`)
    const windows = [usage.fiveHour, usage.sevenDay, ...usage.scoped].filter((w): w is UsageWindow => w !== null)
    if (windows.length) {
      lines.push(`Limits (${SOURCES[usage.source]}${usage.fetchedAt ? `, as of ${localTime(usage.fetchedAt)}` : ''}):`)
      for (const w of windows) {
        lines.push(`- ${windowName(w)}: ${Math.round(w.percent)} % used${w.resetsAt ? `, resets ${localTime(w.resetsAt, now)}` : ''}${forecastText(w, now)}`)
      }
    } else if (usage.status === 'ok') {
      lines.push(usage.message ?? 'There are no limits to show (e.g. an API key, billed by use).')
    }
    if (usage.extra?.enabled) {
      const { usedCredits: used, monthlyLimit: limit, currency } = usage.extra
      const amount = used === null ? '' : `: ${[used.toFixed(2), limit !== null ? `of ${limit.toFixed(2)}` : null, currency].filter(Boolean).join(' ')} used this month`
      lines.push(`Extra usage is on${amount}.`)
    }
  }
  if (input.others.length) {
    lines.push('Other accounts:')
    for (const { account: other, usage: u } of input.others) {
      const parts = [u?.fiveHour ? `5 h ${Math.round(u.fiveHour.percent)} %` : null, u?.sevenDay ? `week ${Math.round(u.sevenDay.percent)} %` : null].filter(Boolean)
      const state = parts.length ? parts.join(', ') : u ? (u.status === 'ok' ? 'no numbers' : u.status) : 'no numbers'
      lines.push(`- ${other.name}: ${state}`)
    }
  }
  lines.push(
    input.autoSwitch
      ? 'Automatic switch at a limit is on: a session that hits a limit continues with the next free account.'
      : 'Automatic switch at a limit is off: at a limit the user switches the account or waits for the reset.',
  )
  return lines.join('\n')
}
