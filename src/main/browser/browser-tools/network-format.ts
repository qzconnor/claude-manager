import type { ActionContext } from '../action-context'
import type { NetworkEntry } from '../network-log'
import { cut } from '../tool-args'

/** Requests for Claude: headers without secrets, bodies as text. */

/** A body in browser_network_request is cut after this many characters. */
export const MAX_BODY_CHARS = 20_000

/** Headers whose values are secrets of the user's logins: Claude gets their names only. */
const SECRET_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token'])

/** Headers for browser_network_request, one per line, with the values of secret ones left out. */
export function headerLines(headers: Record<string, string>): string[] {
  const entries = Object.entries(headers)
  if (entries.length === 0) return ['  (none)']
  return entries.map(([name, value]) => `  ${name}: ${SECRET_HEADERS.has(name.toLowerCase()) ? hiddenValue(name, value) : cut(value, 500)}`)
}

function hiddenValue(name: string, value: string): string {
  const lower = name.toLowerCase()
  if (lower === 'cookie') {
    const names = value.split(';').map((part) => part.split('=')[0].trim()).filter(Boolean)
    return `(${names.length} cookie(s): ${cut(names.join(', '), 200)}; values hidden)`
  }
  if (lower === 'set-cookie') {
    const names = value.split('\n').map((line) => line.split('=')[0].trim()).filter(Boolean)
    return `(sets ${cut(names.join(', '), 200)}; values hidden)`
  }
  if (lower.endsWith('authorization')) return `${value.split(' ')[0]} (hidden)`
  return '(hidden)'
}

/** Whether a body of this type is text worth reading (JSON, HTML, scripts, forms …). */
function isTextType(mimeType: string | null): boolean {
  if (!mimeType) return true
  return /^text\/|json|javascript|ecmascript|xml|x-www-form-urlencoded|graphql|svg/i.test(mimeType)
}

/** A body as Claude reads it: JSON indented, cut after MAX_BODY_CHARS. */
export function bodyText(body: string, mimeType: string | null): string {
  if (body === '') return '(empty)'
  let text = body
  if (/json/i.test(mimeType ?? '') || /^\s*[[{]/.test(body)) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      // Not JSON after all: as it came.
    }
  }
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n… (cut: ${text.length} characters in all)` : text
}

export async function responseBody(ctx: ActionContext, entry: NetworkEntry): Promise<string> {
  if (!isTextType(entry.mimeType)) return `(${entry.mimeType}, ${entry.encodedBytes !== null ? formatBytes(entry.encodedBytes) : 'size unknown'}; not text, not shown)`
  try {
    const { body, base64Encoded } = await ctx.page.cdpIn<{ body: string; base64Encoded: boolean }>(entry.session, 'Network.getResponseBody', {
      requestId: entry.requestId,
    })
    return bodyText(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body, entry.mimeType)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `(not available: ${message.split('\n')[0]}; the browser keeps bodies only for a while, and not for redirects or pages left since)`
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
