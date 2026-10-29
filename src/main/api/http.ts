import type { IncomingMessage, ServerResponse } from 'node:http'

/** Request bodies above this size are rejected. */
const MAX_BODY_BYTES = 1024 * 1024

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'Cache-Control': 'no-store' })
  res.end()
}

export function sendText(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    'Content-Type': `${contentType}; charset=utf-8`,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { status, message } })
}

/** Reads and parses a JSON body. An empty body yields `{}`. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type'] ?? ''
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request-Body ist zu groß (max. 1 MB).')
    chunks.push(buf)
  }
  if (size === 0) return {}
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type muss application/json sein.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Ungültiges JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Der Body muss ein JSON-Objekt sein.')
  }
  return parsed as Record<string, unknown>
}

// --- input validation helpers ----------------------------------------------

export function optionalString(body: Record<string, unknown>, key: string, maxLength = 4096): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new HttpError(400, `„${key}“ muss ein String sein.`)
  if (value.length > maxLength) throw new HttpError(400, `„${key}“ ist zu lang.`)
  return value
}

export function requiredString(body: Record<string, unknown>, key: string, maxLength = 4096): string {
  const value = optionalString(body, key, maxLength)
  if (!value) throw new HttpError(400, `„${key}“ fehlt.`)
  return value
}

export function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new HttpError(400, `„${key}“ muss true oder false sein.`)
  return value
}

export function optionalInteger(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `„${key}“ muss eine Ganzzahl zwischen ${min} und ${max} sein.`)
  }
  return value
}

export function optionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 64 || !value.every((v) => typeof v === 'string' && v.length <= 4096)) {
    throw new HttpError(400, `„${key}“ muss eine Liste von Strings sein (max. 64).`)
  }
  return value as string[]
}

/** Parses an integer query parameter. */
export function queryInteger(params: URLSearchParams, key: string, min: number, max: number): number | undefined {
  const raw = params.get(key)
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `Query-Parameter „${key}“ muss eine Ganzzahl zwischen ${min} und ${max} sein.`)
  }
  return value
}
