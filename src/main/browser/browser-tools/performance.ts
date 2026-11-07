import type { BrowserEmulation } from '@shared/types'
import { delay, withTimeout } from '../page-driver'
import type { ActionContext } from '../action-context'
import { cut, ToolError } from '../tool-args'
import { describeEmulation } from './emulation-args'
import { formatBytes } from './network-format'
import { NAVIGATION_WAIT_MS, pageState, type Reply, untilBlocked } from './tool'

/** browser_performance: load times and Web Vitals of the page, measured in the page. */

/** After a load, until the largest paint and the layout shifts have settled. */
const PERFORMANCE_SETTLE_MS = 1500

export interface PerformanceReport {
  url: string
  navigation: { type: string; ttfb: number; domContentLoaded: number; load: number; transfer: number; protocol: string } | null
  fcp: number | null
  lcp: { time: number; element: string | null; url: string | null } | null
  cls: number | null
  longTasks: { count: number; tbt: number; longest: number } | null
  inp: number | null
  resources: { name: string; type: string; duration: number; size: number }[]
}

/** browser_performance, with the page's counters on (Performance.enable). */
export async function measurePerformance(ctx: ActionContext, p: { reload: boolean; coldCache: boolean }): Promise<Reply> {
  if (p.reload) {
    if (p.coldCache) await ctx.page.cdp('Network.setCacheDisabled', { cacheDisabled: true })
    try {
      await untilBlocked(ctx, async () => {
        ctx.page.contents.reload()
        await ctx.page.settle(NAVIGATION_WAIT_MS)
        // Largest paint and layout shifts settle a moment after the load.
        await delay(PERFORMANCE_SETTLE_MS)
      })
    } finally {
      if (p.coldCache) await ctx.page.cdp('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => undefined)
    }
    const blocked = ctx.dialog() || ctx.login()
    if (blocked) return { text: `The page did not finish loading.\n\n${await pageState(ctx)}` }
  }
  const { result, exceptionDetails } = await withTimeout(
    ctx.page.cdp<{ result: { value?: PerformanceReport }; exceptionDetails?: { text: string } }>('Runtime.evaluate', {
      expression: PERFORMANCE_SCRIPT,
      awaitPromise: true,
      returnByValue: true,
    }),
    15_000,
    'The page did not report its timings in time.',
  )
  if (exceptionDetails || !result.value) throw new ToolError(`The page did not report its timings: ${exceptionDetails?.text ?? 'no answer'}`)
  let metrics: Record<string, number> = {}
  try {
    const answer = await ctx.page.cdp<{ metrics: { name: string; value: number }[] }>('Performance.getMetrics')
    metrics = Object.fromEntries(answer.metrics.map((m) => [m.name, m.value]))
  } catch {
    // Without the page's counters the report has the timings only.
  }
  const report = result.value
  const lcp = report.lcp ? `LCP ${formatMs(report.lcp.time)}` : null
  ctx.note([lcp, report.cls !== null ? `CLS ${report.cls}` : null].filter(Boolean).join(' · ') || 'Gemessen')
  return { text: formatPerformance(report, metrics, { reloaded: p.reload, coldCache: p.coldCache, emulation: ctx.emulation() }) }
}

/** Runs in the page: its timings from the Performance APIs (buffered entries, so also those of the load). */
const PERFORMANCE_SCRIPT = `(async () => {
  const observe = (type, extra) => new Promise((resolve) => {
    const entries = []
    try {
      const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()))
      observer.observe(Object.assign({ type, buffered: true }, extra || {}))
      setTimeout(() => { observer.disconnect(); resolve(entries) }, 200)
    } catch (error) { resolve(null) }
  })
  const [lcp, shifts, tasks, events] = await Promise.all([
    observe('largest-contentful-paint'), observe('layout-shift'), observe('longtask'), observe('event', { durationThreshold: 16 }),
  ])
  const nav = performance.getEntriesByType('navigation')[0]
  const fcp = performance.getEntriesByName('first-contentful-paint')[0]
  const name = (el) => {
    if (!el) return null
    let text = el.tagName.toLowerCase()
    if (el.id) text += '#' + el.id
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : []
    if (cls.length) text += '.' + cls.join('.')
    return text
  }
  const last = lcp && lcp.length ? lcp[lcp.length - 1] : null
  let cls = 0, windowValue = 0, windowStart = 0, previous = -Infinity
  for (const shift of shifts || []) {
    if (shift.hadRecentInput) continue
    if (shift.startTime - previous > 1000 || shift.startTime - windowStart > 5000) { windowValue = 0; windowStart = shift.startTime }
    windowValue += shift.value
    previous = shift.startTime
    cls = Math.max(cls, windowValue)
  }
  const after = fcp ? fcp.startTime : 0
  const long = (tasks || []).filter((t) => t.startTime >= after)
  const interactions = (events || []).filter((e) => e.interactionId).map((e) => e.duration)
  return {
    url: location.href,
    navigation: nav ? { type: nav.type, ttfb: Math.round(nav.responseStart), domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), transfer: nav.transferSize, protocol: nav.nextHopProtocol } : null,
    fcp: fcp ? Math.round(fcp.startTime) : null,
    lcp: last ? { time: Math.round(last.startTime), element: name(last.element), url: last.url || null } : null,
    cls: shifts ? Math.round(cls * 1000) / 1000 : null,
    longTasks: tasks ? { count: long.length, tbt: Math.round(long.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0)), longest: Math.round(long.reduce((max, t) => Math.max(max, t.duration), 0)) } : null,
    inp: interactions.length ? Math.round(Math.max(...interactions)) : null,
    resources: performance.getEntriesByType('resource').map((r) => ({ name: r.name, type: r.initiatorType, duration: Math.round(r.duration), size: r.transferSize })),
  }
})()`

/** Google's thresholds for good and poor, per measure. */
const RATINGS = {
  lcp: [2500, 4000],
  fcp: [1800, 3000],
  ttfb: [800, 1800],
  tbt: [200, 600],
  inp: [200, 500],
  cls: [0.1, 0.25],
} as const

function rating(kind: keyof typeof RATINGS, value: number): string {
  const [good, poor] = RATINGS[kind]
  return value <= good ? 'good' : value <= poor ? 'needs improvement' : 'poor'
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

/** The report of browser_performance. */
export function formatPerformance(
  report: PerformanceReport,
  metrics: Record<string, number>,
  how: { reloaded: boolean; coldCache: boolean; emulation: BrowserEmulation | null },
): string {
  const context = [how.reloaded ? (how.coldCache ? 'loaded again without cache' : 'loaded again') : 'as it is now, not loaded again']
  const emulated = how.emulation ? describeEmulation(how.emulation) : ''
  if (emulated) context.push(`emulating ${emulated}`)
  const lines = [`Performance of ${report.url} (${context.join('; ')}):`, '', 'Web vitals:']
  if (report.lcp) {
    const what = [report.lcp.element, report.lcp.url ? cut(report.lcp.url, 120) : null].filter(Boolean).join(' ')
    lines.push(`- Largest contentful paint: ${formatMs(report.lcp.time)} (${rating('lcp', report.lcp.time)})${what ? ` — ${what}` : ''}`)
  } else lines.push('- Largest contentful paint: not reported')
  if (report.fcp !== null) lines.push(`- First contentful paint: ${formatMs(report.fcp)} (${rating('fcp', report.fcp)})`)
  if (report.cls !== null) lines.push(`- Cumulative layout shift: ${report.cls} (${rating('cls', report.cls)})`)
  if (report.longTasks) {
    const { count, tbt, longest } = report.longTasks
    lines.push(`- Total blocking time: ${formatMs(tbt)} (${rating('tbt', tbt)}), ${count} long task(s)${count ? `, the longest ${formatMs(longest)}` : ''}`)
  }
  lines.push(
    report.inp !== null
      ? `- Interaction to next paint: ${formatMs(report.inp)} (${rating('inp', report.inp)})`
      : '- Interaction to next paint: none yet (measured once you click or type in the page)',
  )

  lines.push('', 'Loading:')
  const nav = report.navigation
  if (nav) {
    lines.push(
      `- Time to first byte: ${formatMs(nav.ttfb)} (${rating('ttfb', nav.ttfb)}); DOMContentLoaded ${formatMs(nav.domContentLoaded)}; load ${nav.load ? formatMs(nav.load) : 'not finished'}; document ${formatBytes(nav.transfer)}${nav.protocol ? ` over ${nav.protocol}` : ''}`,
    )
  }
  const resources = report.resources
  const total = resources.reduce((sum, r) => sum + (r.size || 0), 0)
  const byType = new Map<string, { count: number; size: number }>()
  for (const r of resources) {
    const entry = byType.get(r.type) ?? { count: 0, size: 0 }
    entry.count++
    entry.size += r.size || 0
    byType.set(r.type, entry)
  }
  const types = [...byType]
    .sort((a, b) => b[1].size - a[1].size || b[1].count - a[1].count)
    .map(([type, e]) => `${type} ${e.count} (${formatBytes(e.size)})`)
  lines.push(`- Requests: ${resources.length}, ${formatBytes(total)} over the network${types.length ? `: ${types.join(', ')}` : ''}`)
  const slowest = [...resources].sort((a, b) => b.duration - a.duration).slice(0, 5)
  if (slowest.length) lines.push('- Slowest:', ...slowest.map((r) => `  - ${formatMs(r.duration)} ${r.type} ${cut(r.name, 140)}${r.size ? ` (${formatBytes(r.size)})` : ''}`))
  const largest = [...resources].filter((r) => r.size > 0).sort((a, b) => b.size - a.size).slice(0, 5)
  if (largest.length) lines.push('- Largest:', ...largest.map((r) => `  - ${formatBytes(r.size)} ${r.type} ${cut(r.name, 140)}`))
  if (resources.some((r) => !r.size)) lines.push('  (sizes of 0: from the cache, or another site that does not share its timings)')

  const page: string[] = []
  if (metrics.JSHeapUsedSize) page.push(`JS heap ${formatBytes(metrics.JSHeapUsedSize)}`)
  if (metrics.Nodes) page.push(`${Math.round(metrics.Nodes)} DOM nodes`)
  // The counters start with the measurement (Performance.enable): they tell only about a reload.
  const work: string[] = []
  if (how.reloaded) {
    if (metrics.LayoutCount !== undefined) work.push(`${Math.round(metrics.LayoutCount)} layouts (${formatMs((metrics.LayoutDuration ?? 0) * 1000)})`)
    if (metrics.RecalcStyleCount !== undefined) work.push(`${Math.round(metrics.RecalcStyleCount)} style recalculations (${formatMs((metrics.RecalcStyleDuration ?? 0) * 1000)})`)
    if (metrics.ScriptDuration !== undefined) work.push(`scripts ran ${formatMs(metrics.ScriptDuration * 1000)}`)
  }
  if (page.length || work.length) lines.push('', 'Page:')
  if (page.length) lines.push(`- ${page.join(', ')}`)
  if (work.length) lines.push(`- While loading: ${work.join(', ')}`)
  return lines.join('\n')
}
