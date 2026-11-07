import type { NativeImage } from 'electron'
import type { BrowserLoginRequest } from '@shared/types'
import type { McpToolResult } from '../mcp-protocol'
import { delay, type ElementBox, withTimeout } from '../page-driver'
import type { ActionContext } from '../action-context'
import { describeDialog } from '../page-dialogs'
import { type Args, cut, ToolError } from '../tool-args'
import type { BrowserTools } from './index'

/** How a browser tool is made, and what most of them need: the page's state, their target, a load. */

export interface Reply {
  text: string
  image?: NativeImage
  /** More pictures after `image` (e.g. one per page width). */
  images?: NativeImage[]
}

export interface ToolDefinition<P> {
  name: string
  title: string
  description: string
  properties: Record<string, unknown>
  required?: string[]
  readOnly?: boolean
  /** It deletes something of the user's (the client may ask before it runs). */
  destructive?: boolean
  kind: string
  whileDialog?: boolean
  parse(args: Args): P
  /** The log line before the action knows its target. */
  label(params: P): string
  /** The action in the session's browser. */
  run?(ctx: ActionContext, params: P): Promise<Reply>
  /** Instead of `run`: works on the session's browser tabs, not in one page. */
  session?(tools: BrowserTools, sessionId: string, params: P): Promise<McpToolResult>
}

/** How long Claude's target is shown before it acts on it, at least. */
export const SHOW_MS = 250
/** The click follows the pointer's arrival by this much, so the user sees it land first. */
export const CLICK_AFTER_MOVE_MS = 60
export const NAVIGATION_WAIT_MS = 30_000

export const ref = { type: 'string', description: 'The ref of the element from the latest snapshot, e.g. "e12" (or "f1e5" in a frame).' }
export const element = { type: 'string', description: 'A short description of the element, for the user watching (e.g. "Save button").' }

export function tool<P>(definition: ToolDefinition<P>): ToolDefinition<never> {
  return definition as unknown as ToolDefinition<never>
}

/**
 * The page as Claude reads it, or what blocks it: a dialog, a request for a login. `changes`: after an
 * action only what changed since Claude's last snapshot, when that is shorter.
 */
export async function pageState(ctx: ActionContext, changes = true): Promise<string> {
  const dialog = ctx.dialog()
  if (dialog) return `${describeDialog(dialog)} Answer it with browser_handle_dialog.`
  const login = ctx.login()
  if (login) return describeLogin(login)
  return ctx.snapshot(changes)
}

/** A site's request for a user name and password, for Claude: only the user answers it. */
function describeLogin(login: BrowserLoginRequest): string {
  const who = login.proxy ? `the proxy ${login.host}` : login.host
  const area = login.realm ? ` for ${JSON.stringify(login.realm)}` : ''
  return `The page waits for a user name and password (HTTP authentication of ${who}${area}). The browser asks the user for them; ask them to sign in there (don't ask for the password yourself), then go on with browser_snapshot or browser_wait_for.`
}

/**
 * Waits for `work`, or until the page opens a dialog or asks for a login: both hold the page up
 * until they are answered.
 */
export async function untilBlocked(ctx: ActionContext, work: () => Promise<void>): Promise<void> {
  await Promise.race([work(), ctx.untilDialog(), ctx.untilLogin()])
}

/** Loads a page; a failure is returned for the result, unless a newer navigation took over. */
export async function loadPage(ctx: ActionContext, load: () => Promise<void>): Promise<string | null> {
  try {
    await untilBlocked(ctx, () => withTimeout(load(), NAVIGATION_WAIT_MS, 'timeout'))
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'timeout') return `The page is still loading after ${NAVIGATION_WAIT_MS / 1000} s.`
    // ERR_ABORTED: a redirect of the page or another navigation took over.
    if (message.includes('ERR_ABORTED') || message.includes('(-3)')) return null
    throw new ToolError(`The page could not be opened: ${message}`)
  }
}

/**
 * Finds the element, names the action after it and shows it to the user for a moment. Claude's
 * pointer goes to its middle (`pointer`: and clicks there, as the action does), null: it stays.
 */
export async function target(
  ctx: ActionContext,
  ref: string,
  element: string | undefined,
  label: (name: string) => string,
  pointer: 'click' | 'move' | null,
): Promise<ElementBox> {
  const box = await ctx.page.locate(ref)
  const text = label(targetName(box, element))
  ctx.label(text)
  const moveMs = ctx.highlight(text, box, pointer ? { ...center(box), click: pointer === 'click' } : null)
  await delay(Math.max(SHOW_MS, moveMs + CLICK_AFTER_MOVE_MS))
  return box
}

/** The element as the log names it. */
export function targetName(box: ElementBox, element?: string): string {
  return quote(cut(element?.trim() || box.name || box.role, 60))
}

export function center(box: ElementBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

export function shortAddress(url: string): string {
  try {
    const { host, pathname, search } = new URL(url)
    return cut(host + (pathname === '/' ? '' : pathname) + search, 80)
  } catch {
    return cut(url, 80)
  }
}

export function quote(text: string): string {
  return `„${text}“`
}

export function refOf(args: Args, key = 'ref'): string {
  const value = args[key]
  if (typeof value !== 'string' || !/^(f\d{1,6})?e\d{1,9}$/.test(value.trim())) {
    throw new ToolError(`${key} must be a ref from the latest browser_snapshot, like "e12" (or "f1e5" in a frame).`)
  }
  return value.trim()
}
