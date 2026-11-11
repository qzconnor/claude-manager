import type { ActionContext } from '../action-context'
import { cut, oneOf, optionalBoolean, optionalNumber, optionalString, ToolError } from '../tool-args'
import { str } from './test-code'
import { quote, shortAddress, tool, type ToolDefinition } from './tool'

/**
 * browser_storage: the site's cookies, local storage and session storage. The values of httpOnly
 * cookies stay out: they are what keeps the user logged in (all sessions share the browser's
 * profile), and no script of the page sees them either.
 */

const STORES = ['cookies', 'local', 'session'] as const
type Store = (typeof STORES)[number]
const ACTIONS = ['get', 'set', 'delete', 'clear'] as const
/** A value in a list is cut here; one asked for by name gets more. */
const LIST_VALUE_CHARS = 200
const VALUE_CHARS = 20_000
const MAX_VALUE = 1_000_000

export interface Cookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  size: number
  httpOnly: boolean
  secure: boolean
  session: boolean
  sameSite?: string
}

const STORE_NAMES: Record<Store, string> = { cookies: 'Cookies', local: 'Local Storage', session: 'Session Storage' }

export const storageTools: ToolDefinition<never>[] = [
  tool({
    name: 'browser_storage',
    title: 'Cookies and storage',
    description:
      "Reads and changes what the current site keeps in the browser: its cookies, local storage and session storage. httpOnly cookies (which scripts can't see either, mostly logins) show with name and flags but without their value; set and delete work on them. get: all of them (or one by name); set: a cookie or key; delete: one by name; clear: all of one store. Changes count from the next request or the next read of the page; reload it if it reads them only on load. Values can be secrets (session tokens): don't pass them on or write them to files unless the user asked.",
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'Default: get.' },
      store: { type: 'string', enum: [...STORES], description: 'Which store; get without it reads all three.' },
      name: { type: 'string', description: 'The cookie or key.' },
      value: { type: 'string', description: 'For set: the value.' },
      domain: { type: 'string', description: 'For a cookie: its domain, e.g. ".example.com" for all subdomains; default: the page\'s host.' },
      path: { type: 'string', description: 'For a cookie: its path (default "/").' },
      httpOnly: { type: 'boolean', description: 'For set: a cookie scripts of the page cannot read.' },
      secure: { type: 'boolean', description: 'For set: a cookie only sent over https.' },
      sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'], description: 'For set: when the cookie goes with requests of other sites.' },
      expiresInDays: { type: 'number', description: 'For set: the cookie ends after this many days; default: with the browser session.' },
    },
    // delete and clear take what a site kept, like browser_clear_site_data.
    destructive: true,
    kind: 'storage',
    parse: (args) => {
      const action = oneOf(args, 'action', ACTIONS, 'get')
      const store = args.store === undefined || args.store === null ? null : oneOf(args, 'store', STORES)
      const name = optionalString(args, 'name', 4096)
      const value = optionalString(args, 'value', MAX_VALUE)
      if (action !== 'get' && !store) throw new ToolError(`store is required for ${action}.`)
      if ((action === 'set' || action === 'delete') && !name) throw new ToolError(`name is required for ${action}.`)
      if (action === 'set' && value === undefined) throw new ToolError('value is required for set.')
      if (name && store === 'cookies' && /[;=\s]/.test(name)) throw new ToolError('A cookie name has no spaces, ";" or "=".')
      return {
        action,
        store,
        name,
        value,
        domain: optionalString(args, 'domain', 255)?.trim() || undefined,
        path: optionalString(args, 'path', 1000)?.trim() || undefined,
        httpOnly: optionalBoolean(args, 'httpOnly'),
        secure: optionalBoolean(args, 'secure'),
        sameSite: args.sameSite === undefined || args.sameSite === null ? undefined : oneOf(args, 'sameSite', ['Strict', 'Lax', 'None'] as const),
        expiresInDays: optionalNumber(args, 'expiresInDays', 0, 3650),
      }
    },
    label: (p) => storageLabel(p.action, p.store, p.name),
    run: async (ctx, p) => {
      const url = ctx.page.contents.getURL()
      let origin: string
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('no web page')
        origin = parsed.origin
      } catch {
        throw new ToolError('The browser shows no web page; open the site first.')
      }
      const label = `${storageLabel(p.action, p.store, p.name)} (${shortAddress(origin)})`
      ctx.label(label)
      ctx.highlight(label)
      if (p.action === 'get') {
        const stores = p.store ? [p.store] : [...STORES]
        const parts: string[] = []
        for (const store of stores) parts.push(await readStore(ctx, store, url, p.name))
        ctx.note(p.name ? quote(cut(p.name, 40)) : stores.map((s) => STORE_NAMES[s]).join(', '))
        return { text: `${origin}:\n\n${parts.join('\n\n')}` }
      }
      const store = p.store!
      if (store === 'cookies') return { text: await changeCookies(ctx, p, url, origin) }
      const area = store
      const global = area === 'local' ? 'localStorage' : 'sessionStorage'
      if (p.action === 'set') {
        await ctx.page.call('storage', area, 'set', p.name, p.value, 0)
        ctx.record([`await page.evaluate(() => ${global}.setItem(${str(p.name!)}, ${str(p.value!)}))`])
        return { text: `Set ${JSON.stringify(p.name)} in the ${STORE_NAMES[area].toLowerCase()} of ${origin} (${p.value!.length} characters).` }
      }
      if (p.action === 'delete') {
        const had = await ctx.page.call<boolean>('storage', area, 'remove', p.name, null, 0)
        ctx.record([`await page.evaluate(() => ${global}.removeItem(${str(p.name!)}))`])
        return { text: had ? `Deleted ${JSON.stringify(p.name)} from the ${STORE_NAMES[area].toLowerCase()} of ${origin}.` : `There was no ${JSON.stringify(p.name)} in the ${STORE_NAMES[area].toLowerCase()}.` }
      }
      const count = await ctx.page.call<number>('storage', area, 'clear', null, null, 0)
      ctx.record([`await page.evaluate(() => ${global}.clear())`])
      ctx.note(`${count} Einträge gelöscht`)
      return { text: `Cleared the ${STORE_NAMES[area].toLowerCase()} of ${origin}: ${count} key(s).` }
    },
  }),
]

function storageLabel(action: (typeof ACTIONS)[number], store: Store | null, name: string | undefined): string {
  const what = name ? quote(cut(name, 40)) : store ? STORE_NAMES[store] : 'Cookies und Speicher'
  if (action === 'get') return `Liest ${what}`
  if (action === 'set') return `Setzt ${what}`
  if (action === 'delete') return `Löscht ${what}`
  return `Leert ${store ? STORE_NAMES[store] : 'den Speicher'}`
}

/** A cookie for Claude, its value cut at `chars`; an httpOnly one without its value. */
export function cookieLine(c: Cookie, chars: number): string {
  const flags = [
    `domain ${c.domain}`,
    c.path !== '/' && `path ${c.path}`,
    c.httpOnly && 'httpOnly',
    c.secure && 'secure',
    c.sameSite && `SameSite=${c.sameSite}`,
    c.session ? 'session' : `expires ${new Date(c.expires * 1000).toISOString().slice(0, 10)}`,
  ].filter(Boolean)
  if (c.httpOnly) return `- ${c.name} (value withheld, ${c.value.length} characters) (${flags.join(', ')})`
  const value = cut(c.value, chars)
  return `- ${c.name}=${value}${value.length < c.value.length ? ` (${c.value.length} characters)` : ''} (${flags.join(', ')})`
}

async function pageCookies(ctx: ActionContext, url: string): Promise<Cookie[]> {
  const { cookies } = await ctx.page.cdp<{ cookies: Cookie[] }>('Network.getCookies', { urls: [url] })
  return cookies
}

/** One store for Claude: all its entries, or the one named. */
async function readStore(ctx: ActionContext, store: Store, url: string, name: string | undefined): Promise<string> {
  const title = STORE_NAMES[store]
  if (store === 'cookies') {
    const cookies = (await pageCookies(ctx, url)).filter((c) => !name || c.name === name)
    if (cookies.length === 0) return name ? `${title}: no cookie ${JSON.stringify(name)}.` : `${title}: none.`
    const lines = cookies.map((c) => cookieLine(c, name ? VALUE_CHARS : LIST_VALUE_CHARS))
    return `${title} (${cookies.length}):\n${lines.join('\n')}`
  }
  type Entry = [string, string, number]
  const entries = name
    ? [await ctx.page.call<Entry | null>('storage', store, 'get', name, null, VALUE_CHARS)].filter((e): e is Entry => e !== null)
    : await ctx.page.call<Entry[]>('storage', store, 'list', null, null, LIST_VALUE_CHARS)
  if (entries.length === 0) return name ? `${title}: no key ${JSON.stringify(name)}.` : `${title}: empty.`
  const lines = entries.map(([key, value, length]) => `- ${key} = ${value}${value.length < length ? ` (${length} characters)` : ''}`)
  return `${title} (${entries.length}):\n${lines.join('\n')}`
}

async function changeCookies(
  ctx: ActionContext,
  p: { action: string; name?: string; value?: string; domain?: string; path?: string; httpOnly?: boolean; secure?: boolean; sameSite?: string; expiresInDays?: number },
  url: string,
  origin: string,
): Promise<string> {
  if (p.action === 'set') {
    const expires = p.expiresInDays !== undefined ? Math.round(Date.now() / 1000 + p.expiresInDays * 86_400) : undefined
    const cookie = {
      name: p.name!,
      value: p.value!,
      url,
      ...(p.domain ? { domain: p.domain } : {}),
      path: p.path ?? '/',
      ...(p.httpOnly !== undefined ? { httpOnly: p.httpOnly } : {}),
      ...(p.secure !== undefined ? { secure: p.secure } : {}),
      ...(p.sameSite ? { sameSite: p.sameSite } : {}),
      ...(expires !== undefined ? { expires } : {}),
    }
    const { success } = await ctx.page.cdp<{ success: boolean }>('Network.setCookie', cookie)
    if (!success) throw new ToolError('The browser refused the cookie (SameSite=None needs secure, a domain must fit the page, secure needs https).')
    // Playwright takes a url or a domain with a path.
    const where = p.domain || p.path ? `domain: ${str(p.domain ?? new URL(url).hostname)}, path: ${str(cookie.path)}` : `url: ${str(origin)}`
    const fields = [`name: ${str(cookie.name)}`, `value: ${str(cookie.value)}`, where]
    if (p.httpOnly) fields.push('httpOnly: true')
    if (p.secure) fields.push('secure: true')
    if (p.sameSite) fields.push(`sameSite: ${str(p.sameSite)}`)
    if (p.expiresInDays !== undefined) fields.push(`expires: Math.round(Date.now() / 1000) + ${Math.round(p.expiresInDays * 86_400)}`)
    ctx.record([`await page.context().addCookies([{ ${fields.join(', ')} }])`])
    return `Set the cookie ${JSON.stringify(p.name)} for ${p.domain ?? new URL(url).hostname}${expires ? `, until ${new Date(expires * 1000).toISOString().slice(0, 10)}` : ' (ends with the browser session)'}.`
  }
  const cookies = (await pageCookies(ctx, url)).filter((c) => p.action === 'clear' || c.name === p.name)
  for (const cookie of cookies) await ctx.page.cdp('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path })
  if (p.action === 'delete') {
    ctx.record([`await page.context().clearCookies({ name: ${str(p.name!)} })`])
    return cookies.length ? `Deleted the cookie ${JSON.stringify(p.name)} (${cookies.length}).` : `There was no cookie ${JSON.stringify(p.name)} for this page.`
  }
  ctx.record(['await page.context().clearCookies()'])
  ctx.note(`${cookies.length} Cookies gelöscht`)
  return `Deleted ${cookies.length} cookie(s) of ${origin}${cookies.length ? `: ${cut(cookies.map((c) => c.name).join(', '), 300)}` : ''}. This may sign the browser out of the site.`
}
