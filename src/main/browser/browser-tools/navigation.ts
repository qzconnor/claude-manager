import { addressToUrl, BLANK_PAGE, isBrowsableUrl } from '@shared/browser'
import type { McpToolResult } from '../mcp-protocol'
import type { BrowserTab } from '../action-context'
import { cut, oneOf, optionalNumber, requiredString, ToolError } from '../tool-args'
import { str } from './test-code'
import { loadPage, NAVIGATION_WAIT_MS, pageState, shortAddress, tool, type ToolDefinition } from './tool'

/** Tools that go to pages: open an address, back and forward, the session's browser tabs. */

export const navigationTools: ToolDefinition<never>[] = [
  tool({
    name: 'browser_navigate',
    title: 'Open a page',
    description: 'Opens an address in the browser (http or https; "localhost:5173" works too).',
    properties: { url: { type: 'string', description: 'The address to open.' } },
    required: ['url'],
    kind: 'navigate',
    parse: (args) => {
      const url = addressToUrl(requiredString(args, 'url', 8192))
      if (url === BLANK_PAGE || !isBrowsableUrl(url)) throw new ToolError('The browser opens http and https addresses only.')
      return { url }
    },
    label: ({ url }) => `Öffnet ${shortAddress(url)}`,
    run: async (ctx, { url }) => {
      ctx.highlight(`Öffnet ${shortAddress(url)}`)
      const failure = await loadPage(ctx, url, () => ctx.page.contents.loadURL(url))
      ctx.record([`await page.goto(${str(url)})`])
      return { text: `${failure ?? `Opened ${url}.`}\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_history',
    title: 'Back, forward or reload',
    description: 'Goes back or forward in the history of the browser, or reloads the page.',
    properties: { action: { type: 'string', enum: ['back', 'forward', 'reload'] } },
    required: ['action'],
    kind: 'navigate',
    parse: (args) => ({ action: oneOf(args, 'action', ['back', 'forward', 'reload'] as const) }),
    label: ({ action }) => ({ back: 'Geht zurück', forward: 'Geht vor', reload: 'Lädt die Seite neu' })[action],
    run: async (ctx, { action }) => {
      const history = ctx.page.contents.navigationHistory
      if (action === 'back' && !history.canGoBack()) throw new ToolError('There is no page to go back to.')
      if (action === 'forward' && !history.canGoForward()) throw new ToolError('There is no page to go forward to.')
      ctx.highlight(({ back: 'Geht zurück', forward: 'Geht vor', reload: 'Lädt neu' } as const)[action])
      if (action === 'back') history.goBack()
      else if (action === 'forward') history.goForward()
      else ctx.page.contents.reload()
      await ctx.page.settle(NAVIGATION_WAIT_MS)
      ctx.record([`await page.${({ back: 'goBack', forward: 'goForward', reload: 'reload' } as const)[action]}()`])
      return { text: await pageState(ctx) }
    },
  }),
  tool({
    name: 'browser_tabs',
    title: 'Browser tabs',
    description:
      "Your browser tabs in Claude Manager, and the user's own; other sessions' tabs are theirs and not listed. All share one profile (cookies, logins). list: all of them; new: opens one below your current browser (with url: opens it there); select: your next actions go to that tab; close: closes a tab you opened (without index: your current one). The user's own tabs stay open. When you are done with the browser, close the tabs you opened, unless the user wants to look at what they show.",
    properties: {
      action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
      index: { type: 'number', description: 'For select: the tab from the list (0-based). For close: that tab, or your current one without index.' },
      url: { type: 'string', description: 'For new: the address to open in the new tab.' },
    },
    required: ['action'],
    kind: 'tabs',
    parse: (args) => {
      const action = oneOf(args, 'action', ['list', 'new', 'select', 'close'] as const)
      const index = optionalNumber(args, 'index', 0, 10_000)
      if (action === 'select' && index === undefined) throw new ToolError('index is required for select.')
      let url: string | undefined
      if (args.url !== undefined && args.url !== null) {
        url = addressToUrl(requiredString(args, 'url', 8192))
        if (url === BLANK_PAGE || !isBrowsableUrl(url)) throw new ToolError('The browser opens http and https addresses only.')
      }
      return { action, index: index === undefined ? undefined : Math.floor(index), url }
    },
    label: ({ action }) => ({ list: 'Listet die Tabs', new: 'Öffnet einen Tab', select: 'Wechselt den Tab', close: 'Schließt einen Tab' })[action],
    session: async (tools, sessionId, p) => {
      const { control } = tools
      switch (p.action) {
        case 'list':
          return textResult(listTabs(control.tabs(sessionId)))
        case 'new': {
          const tab = control.openTab(sessionId)
          const head = `Opened tab ${tab.index}; your next actions go to it.`
          if (!p.url) return textResult(`${head}\n\n${listTabs(control.tabs(sessionId))}`)
          return prefixed(head, await tools.call(sessionId, 'browser_navigate', { url: p.url }))
        }
        case 'select': {
          const tab = control.selectTab(sessionId, p.index!)
          return prefixed(`Switched to tab ${tab.index}; your next actions go to it.`, await tools.call(sessionId, 'browser_snapshot', {}))
        }
        case 'close': {
          const tab = control.closeTab(sessionId, p.index)
          return textResult(`Closed tab ${tab.index} (${JSON.stringify(tab.title)}).\n\n${listTabs(control.tabs(sessionId))}`)
        }
      }
    },
  }),
]

function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] }
}

/** A tool's result with a line before it. */
function prefixed(head: string, result: McpToolResult): McpToolResult {
  const [first, ...rest] = result.content
  if (first?.type === 'text') return { ...result, content: [{ type: 'text', text: `${head}\n\n${first.text}` }, ...rest] }
  return { ...result, content: [{ type: 'text', text: head }, ...result.content] }
}

/** The tabs for browser_tabs, with the one the session acts in. */
function listTabs(tabs: BrowserTab[]): string {
  if (tabs.length === 0) return 'There are no browser tabs. browser_tabs new (or any browser action) opens one next to this session.'
  const lines = tabs.map((tab) => {
    const marks = [
      tab.current && 'current',
      tab.openedBySession && 'opened by you',
      tab.otherSession && `used by another Claude session: ${JSON.stringify(tab.otherSession)}`,
    ].filter(Boolean)
    const url = tab.url === BLANK_PAGE ? '(empty)' : tab.url
    return `- ${tab.index}: ${JSON.stringify(cut(tab.title, 80))} ${url}${marks.length ? ` (${marks.join(', ')})` : ''}`
  })
  const none = tabs.some((tab) => tab.current) ? '' : '\nNone is current: your next action opens a browser next to this session, unless you select one.'
  return `Browser tabs:\n${lines.join('\n')}${none}`
}
