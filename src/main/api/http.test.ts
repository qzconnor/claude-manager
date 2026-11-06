import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  HttpError,
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalStringArray,
  queryInteger,
  readJsonBody,
  requiredString,
  sendError,
  sendJson,
  sendNoContent,
} from './http'

/** A request whose body arrives in the given chunks. */
function request(chunks: (string | Buffer)[], contentType?: string): IncomingMessage {
  const stream = Readable.from(chunks.map((chunk) => (typeof chunk === 'string' ? Buffer.from(chunk) : chunk)))
  return Object.assign(stream, { headers: contentType === undefined ? {} : { 'content-type': contentType } }) as unknown as IncomingMessage
}

/** Expects `action` to fail with an HttpError of `status` whose message contains `message`. */
async function expectHttpError(action: () => unknown, status: number, message?: string): Promise<void> {
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(HttpError)
  expect((caught as HttpError).status).toBe(status)
  if (message) expect((caught as HttpError).message).toContain(message)
}

function response() {
  const written: { status?: number; headers?: Record<string, unknown>; body?: string } = {}
  const res = {
    writeHead(status: number, headers: Record<string, unknown>) {
      written.status = status
      written.headers = headers
      return res
    },
    end(body?: string) {
      written.body = body
    },
  }
  return { res: res as unknown as ServerResponse, written }
}

describe('HttpError', () => {
  it('is an Error with a status', () => {
    const error = new HttpError(404, 'nope')
    expect(error).toBeInstanceOf(Error)
    expect(error.status).toBe(404)
    expect(error.message).toBe('nope')
  })
})

describe('readJsonBody', () => {
  it('parses a JSON object', async () => {
    expect(await readJsonBody(request(['{"a":1,"b":[true]}'], 'application/json'))).toEqual({ a: 1, b: [true] })
  })

  it('accepts the content type in any case and with parameters', async () => {
    expect(await readJsonBody(request(['{"a":1}'], 'Application/JSON; charset=utf-8'))).toEqual({ a: 1 })
  })

  it('joins chunks before decoding, so split characters survive', async () => {
    const bytes = Buffer.from('{"name":"Müller ✓"}')
    const split = bytes.indexOf(0xc3) + 1
    const body = await readJsonBody(request([bytes.subarray(0, split), bytes.subarray(split)], 'application/json'))
    expect(body).toEqual({ name: 'Müller ✓' })
  })

  it('treats an empty body as an empty object, whatever the content type', async () => {
    expect(await readJsonBody(request([]))).toEqual({})
    expect(await readJsonBody(request([], 'text/plain'))).toEqual({})
  })

  it('refuses a body that is not declared as JSON', async () => {
    await expectHttpError(() => readJsonBody(request(['{"a":1}'], 'text/plain')), 415)
    await expectHttpError(() => readJsonBody(request(['{"a":1}'])), 415)
  })

  it('refuses invalid JSON', async () => {
    await expectHttpError(() => readJsonBody(request(['{"a":'], 'application/json')), 400, 'Ungültiges JSON')
  })

  it.each([['[1,2]'], ['null'], ['42'], ['"text"'], ['true']])('refuses %s, which is no object', async (body) => {
    await expectHttpError(() => readJsonBody(request([body], 'application/json')), 400, 'JSON-Objekt')
  })

  it('refuses a body over 1 MB', async () => {
    const half = Buffer.alloc(512 * 1024, 0x20)
    await expectHttpError(() => readJsonBody(request([half, half, Buffer.from('{}')], 'application/json')), 413)
  })

  it('accepts a body of exactly 1 MB', async () => {
    const padding = Buffer.alloc(1024 * 1024 - 2, 0x20)
    expect(await readJsonBody(request([Buffer.from('{'), padding, Buffer.from('}')], 'application/json'))).toEqual({})
  })
})

describe('optionalString', () => {
  it('returns strings and treats null like a missing value', () => {
    expect(optionalString({ a: 'x' }, 'a')).toBe('x')
    expect(optionalString({ a: '' }, 'a')).toBe('')
    expect(optionalString({}, 'a')).toBeUndefined()
    expect(optionalString({ a: null }, 'a')).toBeUndefined()
  })

  it('refuses other types and overlong strings', async () => {
    await expectHttpError(() => optionalString({ a: 1 }, 'a'), 400, '„a“ muss ein String sein')
    await expectHttpError(() => optionalString({ a: ['x'] }, 'a'), 400)
    expect(optionalString({ a: 'abc' }, 'a', 3)).toBe('abc')
    await expectHttpError(() => optionalString({ a: 'abcd' }, 'a', 3), 400, 'zu lang')
    await expectHttpError(() => optionalString({ a: 'x'.repeat(4097) }, 'a'), 400, 'zu lang')
  })
})

describe('requiredString', () => {
  it('returns a non-empty string', () => {
    expect(requiredString({ id: 'system' }, 'id')).toBe('system')
  })

  it.each([[{}], [{ id: null }], [{ id: '' }]])('refuses %o as missing', async (body) => {
    await expectHttpError(() => requiredString(body, 'id'), 400, '„id“ fehlt')
  })

  it('refuses other types', async () => {
    await expectHttpError(() => requiredString({ id: 5 }, 'id'), 400, 'String')
  })
})

describe('optionalBoolean', () => {
  it('returns booleans only', async () => {
    expect(optionalBoolean({ a: true }, 'a')).toBe(true)
    expect(optionalBoolean({ a: false }, 'a')).toBe(false)
    expect(optionalBoolean({ a: null }, 'a')).toBeUndefined()
    expect(optionalBoolean({}, 'a')).toBeUndefined()
    await expectHttpError(() => optionalBoolean({ a: 'true' }, 'a'), 400)
    await expectHttpError(() => optionalBoolean({ a: 1 }, 'a'), 400)
  })
})

describe('optionalInteger', () => {
  it('accepts integers within the bounds, bounds included', () => {
    expect(optionalInteger({ n: 20 }, 'n', 20, 500)).toBe(20)
    expect(optionalInteger({ n: 500 }, 'n', 20, 500)).toBe(500)
    expect(optionalInteger({ n: null }, 'n', 20, 500)).toBeUndefined()
    expect(optionalInteger({}, 'n', 20, 500)).toBeUndefined()
  })

  it.each([[19], [501], [20.5], ['30'], [Number.NaN], [Number.POSITIVE_INFINITY]])('refuses %s', async (value) => {
    await expectHttpError(() => optionalInteger({ n: value }, 'n', 20, 500), 400, 'zwischen 20 und 500')
  })
})

describe('optionalStringArray', () => {
  it('accepts lists of strings', () => {
    expect(optionalStringArray({ a: ['--model', 'opus'] }, 'a')).toEqual(['--model', 'opus'])
    expect(optionalStringArray({ a: [] }, 'a')).toEqual([])
    expect(optionalStringArray({ a: null }, 'a')).toBeUndefined()
    expect(optionalStringArray({ a: Array(64).fill('x') }, 'a')).toHaveLength(64)
  })

  it.each([
    ['a string', '--model'],
    ['a list with a number', ['a', 1]],
    ['more than 64 entries', Array(65).fill('x')],
    ['an overlong entry', ['x'.repeat(4097)]],
  ])('refuses %s', async (_name, value) => {
    await expectHttpError(() => optionalStringArray({ a: value }, 'a'), 400)
  })
})

describe('queryInteger', () => {
  const query = (text: string) => new URLSearchParams(text)

  it('parses integers within the bounds', () => {
    expect(queryInteger(query('days=7'), 'days', 1, 365)).toBe(7)
    expect(queryInteger(query('days=365'), 'days', 1, 365)).toBe(365)
  })

  it('treats a missing or empty parameter as not given', () => {
    expect(queryInteger(query(''), 'days', 1, 365)).toBeUndefined()
    expect(queryInteger(query('days='), 'days', 1, 365)).toBeUndefined()
  })

  it.each([['days=0'], ['days=366'], ['days=1.5'], ['days=abc'], ['days=-1'], ['days=Infinity']])('refuses %s', async (text) => {
    await expectHttpError(() => queryInteger(query(text), 'days', 1, 365), 400, 'Query-Parameter „days“')
  })
})

describe('responses', () => {
  it('sends JSON with its byte length and without caching', () => {
    const { res, written } = response()
    sendJson(res, 201, { name: 'Ä' })
    expect(written.status).toBe(201)
    expect(written.body).toBe('{"name":"Ä"}')
    expect(written.headers).toMatchObject({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': 13,
      'Cache-Control': 'no-store',
    })
  })

  it('wraps errors in an error object', () => {
    const { res, written } = response()
    sendError(res, 404, 'Nicht gefunden')
    expect(written.status).toBe(404)
    expect(JSON.parse(written.body ?? '')).toEqual({ error: { status: 404, message: 'Nicht gefunden' } })
  })

  it('sends 204 without a body', () => {
    const { res, written } = response()
    sendNoContent(res)
    expect(written.status).toBe(204)
    expect(written.body).toBeUndefined()
  })
})
