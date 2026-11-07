import type { ActionContext, RecordedStep } from '../action-context'
import { isFrameRef } from '../frames'
import { patternRegExp, type Route } from '../page-routes'

/**
 * Claude's actions as a Playwright test (browser_generate_test): each tool records lines of code
 * for what it did (`ActionContext.record`), with locators as Playwright recommends them (test id,
 * role and name, label, placeholder, text), and the generator puts them into a test.
 */

/** What the page script `locator` tells about an element. */
export interface LocatorInfo {
  role: string
  name: string
  testId: string
  label: string
  placeholder: string
  text: string
  /** Visible elements of the role whose name contains the name (Playwright's default match) … */
  same: number
  /** … and whose name is the name; `index`: the element's place among those. */
  exact: number
  index: number
  css: string
}

/** Roles `getByRole` knows that the page script names (it calls others clickable, draggable, iframe). */
const ROLES = new Set([
  'alert', 'article', 'banner', 'button', 'cell', 'checkbox', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'dialog',
  'figure', 'form', 'group', 'heading', 'img', 'link', 'list', 'listbox', 'listitem', 'main', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'navigation', 'option', 'paragraph', 'progressbar', 'radio', 'region', 'row', 'searchbox', 'slider', 'spinbutton',
  'status', 'switch', 'tab', 'table', 'textbox', 'treeitem', 'blockquote',
])

/** U+2028 and U+2029: line breaks to JavaScript inside a string. */
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g')

/** A string for TypeScript, in single quotes. */
export function str(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(LINE_SEPARATORS, ' ')}'`
}

/** The locator Playwright recommends for an element, as code. */
export function locatorCode(info: LocatorInfo, frame = false): string {
  const scope = frame ? `page.frameLocator('iframe').first()` : 'page'
  if (info.testId) return `${scope}.getByTestId(${str(info.testId)})`
  if (info.role && ROLES.has(info.role) && info.name) {
    const name = str(info.name)
    if (info.same <= 1) return `${scope}.getByRole(${str(info.role)}, { name: ${name} })`
    if (info.exact <= 1) return `${scope}.getByRole(${str(info.role)}, { name: ${name}, exact: true })`
    return `${scope}.getByRole(${str(info.role)}, { name: ${name}, exact: true }).nth(${info.index})`
  }
  if (info.label) return `${scope}.getByLabel(${str(info.label)})`
  if (info.placeholder) return `${scope}.getByPlaceholder(${str(info.placeholder)})`
  if (info.role && ROLES.has(info.role) && !info.name) return `${scope}.locator(${str(info.css)})`
  if (info.text) return `${scope}.getByText(${str(info.text)}, { exact: true })`
  return `${scope}.locator(${str(info.css)})`
}

/** The locator of an element by its ref (null when the page can't tell: no code is recorded for it then). */
export async function locate(ctx: ActionContext, ref: string): Promise<string | null> {
  try {
    const info = await ctx.page.callAt<LocatorInfo>(ref, 'locator')
    return locatorCode(info, isFrameRef(ref))
  } catch {
    return null
  }
}

/** Playwright's names of mouse buttons and modifier keys. */
export function clickOptions(options: { button?: string; clickCount?: number; modifiers?: string[] }): string {
  const parts: string[] = []
  if (options.button && options.button !== 'left') parts.push(`button: ${str(options.button)}`)
  if (options.modifiers?.length) parts.push(`modifiers: [${options.modifiers.map(str).join(', ')}]`)
  return parts.length ? `{ ${parts.join(', ')} }` : ''
}

/** How a dialog was answered, as Playwright's handler for the next one. */
export function dialogCode(answer: string): string {
  if (answer === 'Cancel') return `page.once('dialog', (dialog) => dialog.dismiss())`
  if (answer === 'OK') return `page.once('dialog', (dialog) => dialog.accept())`
  let text = answer
  try {
    text = JSON.parse(answer) as string
  } catch {
    // the answer as it is
  }
  return `page.once('dialog', (dialog) => dialog.accept(${str(text)}))`
}

/** Playwright's names of the network errors of browser_route. */
const ABORT_CODES: Record<string, string> = {
  failed: 'failed',
  blocked: 'blockedbyclient',
  timedout: 'timedout',
  refused: 'connectionrefused',
  offline: 'internetdisconnected',
}

/** A route of browser_route as Playwright's page.route. */
export function routeCode(route: Omit<Route, 'id' | 'hits'>): string[] {
  const pattern = patternRegExp(route.pattern.includes('*') ? route.pattern : `*${route.pattern}*`)
  const lines: string[] = []
  const body: string[] = []
  if (route.method) body.push(`if (route.request().method() !== ${str(route.method)}) return route.fallback()`)
  if (route.delayMs) body.push(`await new Promise((resolve) => setTimeout(resolve, ${route.delayMs}))`)
  if (route.action === 'fail') body.push(`await route.abort(${str(ABORT_CODES[route.error ?? 'failed'] ?? 'failed')})`)
  else if (route.action === 'delay') body.push('await route.continue()')
  else {
    const fields = [`status: ${route.status ?? 200}`]
    const headers = { ...route.headers }
    const typeKey = Object.keys(headers).find((name) => name.toLowerCase() === 'content-type')
    if (typeKey) {
      fields.push(`contentType: ${str(headers[typeKey])}`)
      delete headers[typeKey]
    }
    if (Object.keys(headers).length) fields.push(`headers: ${JSON.stringify(headers)}`)
    fields.push(`body: ${str(route.body)}`)
    body.push(`await route.fulfill({ ${fields.join(', ')} })`)
  }
  const times = route.timesLeft !== null ? `, { times: ${route.timesLeft} }` : ''
  lines.push(`await page.route(${pattern.toString()}, async (route) => {`)
  for (const line of body) lines.push(`  ${line}`)
  lines.push(`}${times})`)
  return lines
}

/** JavaScript of browser_evaluate for page.evaluate: a function as it is, an expression in one. */
export function evaluateCode(code: string): string {
  const source = code.trim()
  const isFunction = /^(async\s+)?(function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(source)
  return `await page.evaluate(${isFunction ? source : `() => (${source})`})`
}

/** The whole test: what the session did, from the address it started at. */
export function generateTest(steps: RecordedStep[], name: string): string {
  const body: string[] = []
  let browserId: string | null = null
  for (const step of steps) {
    const navigates = step.code.some((line) => line.startsWith('await page.goto('))
    if (step.browserId !== browserId) {
      if (browserId !== null) body.push('', '// Claude went on in another browser tab here.')
      if (!navigates && /^https?:/.test(step.url)) body.push(`await page.goto(${str(step.url)})`)
      browserId = step.browserId
    }
    body.push(...step.code)
  }
  const uses = body.some((line) => line.includes('expect(')) ? 'test, expect' : 'test'
  return [
    `import { ${uses} } from '@playwright/test'`,
    '',
    `test(${str(name)}, async ({ page }) => {`,
    ...body.map((line) => (line ? `  ${line}` : '')),
    '})',
    '',
  ].join('\n')
}
