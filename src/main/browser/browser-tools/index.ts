import type { ActionStep } from '../action-context'
import type { BrowserControl } from '../browser-control'
import type { McpContent, McpTool, McpToolResult } from '../mcp-protocol'
import { type Args, cut, ToolError } from '../tool-args'
import { debuggingTools } from './debugging'
import { interactionTools } from './interaction'
import { navigationTools } from './navigation'
import { readingTools } from './reading'
import type { ToolDefinition } from './tool'

/**
 * The tools of the browser's MCP server, in the manner of Playwright's MCP server: Claude reads the
 * page as an outline with refs (`browser_snapshot`) and acts on elements by their ref. Every action is
 * shown in the page and logged (BrowserControl); the labels of the log are German like the app.
 * The tools themselves are in the files next to this one, by what they do.
 */

export const BROWSER_INSTRUCTIONS = `Claude Manager shows a browser next to this session; these tools drive it while the user watches: every action is highlighted on the page and logged next to it. Use it to open and test web apps (e.g. a dev server on localhost), to read pages and to fill in forms.
- Start with browser_navigate or browser_snapshot: an outline of the page in which elements you can act on carry a ref like [ref=e12]. Pass the ref (and a short description as element) to act on it. Refs change with the page: use those of the latest snapshot.
- After an action on the same page you get only what changed since your last snapshot, as a diff (+ came, - went, unmarked lines show where); everything else and its refs stay valid. After a navigation, or when most of the page changed, you get the whole outline. browser_snapshot always gives the whole page.
- Frames of other sites (payment forms, captchas, embeds) appear inside their iframe line; refs in them look like f1e5 and work like the others.
- Prefer snapshots for reading; take a screenshot when the look matters.
- To debug: browser_console_messages, browser_network_requests and browser_network_request (headers and bodies of one request). browser_emulate tries dark mode, slow or no network, a slow CPU, other languages and time zones; browser_performance measures load and Web Vitals; browser_clear_site_data starts a site fresh.
- Dialogs the page opens while you act (alert, confirm, prompt) are answered at once: with OK, and a prompt with its default. The result of the action tells you about them. To answer the next one differently, call browser_handle_dialog before the action that opens it.
- browser_resize gives the page another size, to test layouts (phone, tablet, large screens); it stays until you reset it or the session ends.
- browser_tabs lists the app's browser tabs, opens another one or switches to one; your actions go to the current one.
- Downloads land in the user's downloads folder; results name the file. Popups (e.g. "Sign in with …") open as windows of their own that you can't drive: the user completes them. The same goes for a site's request for a user name and password.
- The user can take the browser over at any time. Your call then waits until they hand it back and tells you that the page may have changed.
- The browser has its own profile (cookies, logins) apart from the user's other browsers. Don't enter passwords or payment details unless the user asked you to.`

const TOOLS: ToolDefinition<never>[] = [...navigationTools, ...readingTools, ...interactionTools, ...debuggingTools]

/** The tools for the MCP server, and their calls for one session. */
export class BrowserTools {
  constructor(readonly control: BrowserControl) {}

  list(): McpTool[] {
    return TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: { type: 'object', properties: t.properties, ...(t.required ? { required: t.required } : {}), additionalProperties: false },
      annotations: { title: t.title, readOnlyHint: t.readOnly === true, destructiveHint: t.destructive === true, openWorldHint: true },
    }))
  }

  async call(sessionId: string, name: string, args: Args): Promise<McpToolResult> {
    const definition = TOOLS.find((t) => t.name === name) as ToolDefinition<unknown> | undefined
    if (!definition) throw new ToolError(`Unknown tool: ${name}`)
    const params = definition.parse(args)
    if (definition.session) return definition.session(this, sessionId, params)
    const run = definition.run!
    const step: ActionStep = { kind: definition.kind, label: definition.label(params), whileDialog: definition.whileDialog }
    const reply = await this.control.perform(sessionId, step, async (ctx) => {
      const since = new Date().toISOString()
      const reply = await run(ctx, params)
      // Popups and downloads the page started, also a moment after the last action.
      const events = ctx.pageEvents()
      if (events.length > 0) reply.text = `${events.map((e) => e.text).join('\n')}\n\n${reply.text}`
      const dialogs = ctx.caughtDialogs(since)
      if (dialogs.length > 0) {
        const lines = dialogs.map((d) => `- ${d.type} ${JSON.stringify(cut(d.message, 300))}, answered: ${d.answer}`)
        reply.text = `The page opened dialogs, answered at once:\n${lines.join('\n')}\n\n${reply.text}`
      }
      // Errors of the page during the action belong to its result.
      const errors = ctx.consoleEntries().filter((e) => e.level === 'error' && e.at >= since)
      if (errors.length > 0 && definition.kind !== 'console') {
        const lines = errors.slice(-5).map((e) => `- ${cut(e.text.split('\n')[0], 300)}`)
        reply.text = `New console errors:\n${lines.join('\n')}\n\n${reply.text}`
      }
      return reply
    })
    const content: McpContent[] = [{ type: 'text', text: reply.text }]
    if (reply.image) content.push({ type: 'image', data: reply.image.toJPEG(85).toString('base64'), mimeType: 'image/jpeg' })
    return { content }
  }
}
