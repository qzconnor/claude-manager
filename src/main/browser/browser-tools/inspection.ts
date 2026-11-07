import { parseRef } from '../frames'
import type { AuditIssue } from '../page-driver'
import { cut, optionalBoolean, optionalNumber, optionalString, ToolError } from '../tool-args'
import { element, quote, ref, refOf, tool, type ToolDefinition } from './tool'

/** Tools that look closer at the page: find elements, inspect one, check accessibility. */

const MAX_FIND = 100
const DEFAULT_FIND = 20
const MAX_STYLE_PROPERTIES = 30
/** Elements per rule the accessibility check lists. */
const AUDIT_PER_RULE = 8

/** What an inspection of an element (page script `inspect`) tells. */
interface Inspection {
  line: string
  tag: string
  role: string
  name: string
  states: string[]
  attributes: [string, string][]
  box: { x: number; y: number; width: number; height: number; margin: number[]; padding: number[]; border: number[] }
  styles: [string, string][]
  asked: [string, string][]
  hidden: string | null
  ariaHidden: boolean
  place: string
  covered: string | null
  disabled: boolean
  pointerEvents: string
  contrast: { ratio: number; needed: number; color: string; background: string; large: boolean } | null
  text: string
  path: string
  children: number
  frame: string
}

export const inspectionTools: ToolDefinition<never>[] = [
  tool({
    name: 'browser_find',
    title: 'Find elements',
    description:
      'Finds elements by text or role in the whole page, also beyond what the snapshot shows (it is cut on long pages) and in frames: each with a ref to act on, where it is (region, in view or how far down) and the text around it. Text matches names of elements (buttons, links, fields) and text on the page; with role only elements of that role (e.g. "button", "link", "textbox", "heading", "checkbox").',
    properties: {
      text: { type: 'string', description: 'The text to look for (case-insensitive, a part of it matches unless exact).' },
      role: { type: 'string', description: 'Only elements of this role, as the snapshot names them (button, link, textbox, heading, row …).' },
      exact: { type: 'boolean', description: 'The whole name or text must be the text.' },
      limit: { type: 'number', description: `At most this many (default ${DEFAULT_FIND}, up to ${MAX_FIND}).` },
    },
    readOnly: true,
    kind: 'find',
    parse: (args) => {
      const text = optionalString(args, 'text', 500)?.trim() ?? ''
      const role = optionalString(args, 'role', 40)?.trim().toLowerCase() ?? ''
      if (!text && !role) throw new ToolError('Give text, role or both.')
      return { text, role, exact: optionalBoolean(args, 'exact') ?? false, limit: Math.floor(optionalNumber(args, 'limit', 1, MAX_FIND) ?? DEFAULT_FIND) }
    },
    label: (p) => `Sucht ${[p.role, p.text && quote(cut(p.text, 50))].filter(Boolean).join(' ')}`,
    run: async (ctx, p) => {
      const found = await ctx.page.find(p.text, p.role, p.exact, p.limit)
      const what = [p.role && `role ${p.role}`, p.text && `${p.exact ? 'exactly ' : ''}${JSON.stringify(p.text)}`].filter(Boolean).join(' with ')
      ctx.note(`${found.items.length} von ${found.total} Treffern`)
      if (found.total === 0) return { text: `Nothing on the page matches ${what}.` }
      const shown = found.total - found.hidden
      if (shown === 0) return { text: `Nothing visible matches ${what}; ${found.hidden} match(es) are hidden (not shown on the page). browser_snapshot leaves hidden elements out too.` }
      const lines = found.items.map((item) => {
        const where = [item.region && `in ${item.region}`, item.place].filter(Boolean).join(', ')
        return `- ${item.line} (${where})${item.context ? `\n  context: ${JSON.stringify(item.context)}` : ''}`
      })
      const more = shown > found.items.length ? `\n… ${shown - found.items.length} more; narrow the search or raise limit.` : ''
      const hidden = found.hidden ? `\n${found.hidden} more match(es) are hidden (not shown on the page).` : ''
      return { text: `${shown} visible element(s) match ${what}:\n${lines.join('\n')}${more}${hidden}\n\nThe refs work with the other tools; elements out of view are scrolled to when you act on them.` }
    },
  }),
  tool({
    name: 'browser_inspect',
    title: 'Inspect an element',
    description:
      "Looks at one element like the browser's DevTools: its size and box model (margin, border, padding), computed styles that matter (layout, flex or grid, colors, fonts …), attributes, role and accessible name, the contrast of its text, and why it might not be seen or clicked: hidden (and by what), outside the viewport, clipped by a parent, or covered by another element. Changes nothing.",
    properties: {
      ref,
      element,
      properties: { type: 'array', items: { type: 'string' }, description: 'More CSS properties to read, e.g. ["grid-template-areas", "--brand-color"].' },
    },
    required: ['ref'],
    readOnly: true,
    kind: 'inspect',
    whileDialog: false,
    parse: (args) => {
      const extra = args.properties
      if (extra !== undefined && extra !== null && (!Array.isArray(extra) || extra.some((p) => typeof p !== 'string' || p.length > 100))) {
        throw new ToolError('properties must be a list of CSS property names.')
      }
      const properties = ((extra as string[] | undefined) ?? []).slice(0, MAX_STYLE_PROPERTIES)
      return { ref: refOf(args), element: optionalString(args, 'element', 200), properties }
    },
    label: (p) => `Untersucht ${p.element ? quote(p.element) : p.ref}`,
    run: async (ctx, p) => {
      const info = await ctx.page.callAt<Inspection>(p.ref, 'inspect', p.properties)
      const name = quote(cut(p.element?.trim() || info.name || info.role || info.tag, 60))
      ctx.label(`Untersucht ${name}`)
      // Show it to the user where it is, unless it is out of sight or in a frame of another site.
      if (parseRef(p.ref).frame === null && !info.hidden && (info.place === 'in view' || info.place === 'partly in view')) {
        ctx.highlight(`Untersucht ${name}`, info.box)
      }
      ctx.note(info.hidden ? 'verborgen' : info.covered ? 'verdeckt' : info.place)
      return { text: formatInspection(info) }
    },
  }),
  tool({
    name: 'browser_check_accessibility',
    title: 'Check accessibility',
    description:
      'Checks the page for problems of accessibility a script can find, like axe or Lighthouse (fewer rules): images without alt text, fields, buttons and links without names, text with too little contrast (WCAG AA), roles that are no ARIA roles, focusable elements hidden from screen readers, positive tabindex, skipped heading levels, small click targets, missing lang and title, zoom turned off, duplicate ids that labels use. Each problem names its element with a ref. Not a full audit: keyboard use, focus order and screen readers need a person.',
    properties: {},
    readOnly: true,
    kind: 'a11y',
    parse: () => ({}),
    label: () => 'Prüft die Barrierefreiheit',
    run: async (ctx) => {
      ctx.highlight('Prüft die Barrierefreiheit')
      const result = await ctx.page.audit(AUDIT_PER_RULE)
      const total = Object.values(result.counts).reduce((sum, n) => sum + n, 0)
      ctx.note(total ? `${total} Probleme` : 'Keine Probleme gefunden')
      const frames = result.foreign ? `\n${result.foreign} frame(s) of other sites were not checked; take a browser_snapshot first so they are known.` : ''
      if (total === 0) return { text: `No problems found among ${result.checked} elements.${frames}\nThis covers what a script can check; try the page with the keyboard too (Tab, Enter, Escape).` }
      return { text: `${formatAudit(result.issues, result.counts)}\n\nChecked ${result.checked} elements.${frames}` }
    },
  }),
]

/** The four sides of margin, border or padding, shortened like CSS. */
function sides([top, right, bottom, left]: number[]): string {
  if (top === right && right === bottom && bottom === left) return `${top}`
  if (top === bottom && right === left) return `${top} ${right}`
  return `${top} ${right} ${bottom} ${left}`
}

export function formatInspection(info: Inspection): string {
  const b = info.box
  const lines = [info.line]
  if (info.frame) lines.push(`(${info.frame})`)
  lines.push(`Element: <${info.tag}>${info.role ? `, role ${info.role}` : ''}${info.name ? `, name ${JSON.stringify(info.name)}` : ', no accessible name'}${info.states.length ? ` [${info.states.join(', ')}]` : ''}`)
  lines.push(`CSS path: ${info.path}`)
  const problems: string[] = []
  if (info.hidden) problems.push(`not visible: ${info.hidden}`)
  if (info.ariaHidden) problems.push('hidden from screen readers (aria-hidden or inert)')
  if (info.covered) problems.push(`covered by ${info.covered} at its middle: a click would hit that`)
  if (info.disabled) problems.push('disabled')
  if (info.pointerEvents === 'none') problems.push('pointer-events: none (clicks go through it)')
  lines.push(`Visibility: ${info.place}${problems.length ? `; ${problems.join('; ')}` : ''}`)
  lines.push(
    `Box: ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width * 10) / 10}×${Math.round(b.height * 10) / 10} px in the viewport; margin ${sides(b.margin)}, border ${sides(b.border)}, padding ${sides(b.padding)}`,
  )
  if (info.contrast) {
    const c = info.contrast
    const verdict = c.ratio >= c.needed ? 'passes' : 'fails'
    lines.push(`Text contrast: ${c.ratio}:1, ${verdict} WCAG AA (${c.needed}:1 for ${c.large ? 'large' : 'normal'} text): ${c.color} on ${c.background} (estimated from the backgrounds behind it)`)
  }
  if (info.text) lines.push(`Text: ${JSON.stringify(info.text)}`)
  if (info.attributes.length) lines.push('Attributes:', ...info.attributes.map(([name, value]) => `  ${name}=${JSON.stringify(value)}`))
  lines.push('Computed styles:', ...info.styles.map(([name, value]) => `  ${name}: ${value}`))
  if (info.asked.length) lines.push('Asked for:', ...info.asked.map(([name, value]) => `  ${name}: ${value}`))
  lines.push(`Children: ${info.children} element(s)`)
  return lines.join('\n')
}

const RULE_TITLES: Record<string, string> = {
  'html-lang': 'Language of the page',
  'document-title': 'Title of the page',
  zoom: 'Zoom',
  'aria-hidden-focus': 'Focusable elements hidden from screen readers',
  'frame-title': 'Frames without title',
  'aria-role': 'Invalid ARIA roles',
  'image-alt': 'Images without alt text',
  'form-label': 'Fields without label',
  'button-name': 'Buttons without name',
  'link-name': 'Links without name',
  tabindex: 'Positive tabindex',
  'heading-order': 'Skipped heading levels',
  contrast: 'Text contrast (WCAG AA)',
  'target-size': 'Small click targets',
  'duplicate-id': 'Duplicate ids',
}

/** The problems by rule, errors first, each with how many there are in all. */
export function formatAudit(issues: AuditIssue[], counts: Record<string, number>): string {
  const rules = Object.keys(counts).sort((a, b) => {
    const severity = (rule: string) => (issues.find((i) => i.rule === rule)?.severity === 'error' ? 0 : 1)
    return severity(a) - severity(b) || counts[b] - counts[a]
  })
  const errors = issues.filter((i) => i.severity === 'error').length
  const out = [`${Object.values(counts).reduce((s, n) => s + n, 0)} problem(s) in ${rules.length} rule(s)${errors ? '' : ', none of them errors'}:`]
  for (const rule of rules) {
    const listed = issues.filter((i) => i.rule === rule)
    const severity = listed.some((i) => i.severity === 'error') ? 'error' : 'warning'
    out.push('', `${RULE_TITLES[rule] ?? rule} [${severity}, ${counts[rule]}]:`)
    for (const issue of listed) out.push(issue.line ? `- ${issue.line}\n  ${issue.detail}` : `- ${issue.detail}`)
    if (counts[rule] > listed.length) out.push(`- … ${counts[rule] - listed.length} more`)
  }
  return out.join('\n')
}
