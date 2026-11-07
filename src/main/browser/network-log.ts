/** The requests of a page, followed through the DevTools protocol's events (browser_network_requests). */

export const NETWORK_LIMIT = 300
/** Messages of one WebSocket (or event stream) that are kept: the newest. */
export const MESSAGE_LIMIT = 200
const MAX_MESSAGE_CHARS = 2000

/** A message of a WebSocket or an event stream (server-sent events). */
export interface SocketMessage {
  /** When (ms since the epoch). */
  at: number
  direction: 'sent' | 'received' | 'error'
  /** Text, or for binary data its size; an error's message. */
  data: string
  binary: boolean
}

export interface NetworkEntry {
  /** Its number for Claude (browser_network_request). */
  id: number
  /** The DevTools protocol's id, and the session of its frame (undefined: the page's), for its body. */
  requestId: string
  session: string | undefined
  method: string
  url: string
  type: string
  status: number | null
  statusText: string
  failure: string | null
  mimeType: string | null
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string> | null
  /** The body the page sent; null with `hasPostData`: too large for the event, ask the protocol. */
  postData: string | null
  hasPostData: boolean
  /** When it started (ms since the epoch) and how long it took until its end. */
  startedAt: number
  durationMs: number | null
  /** Bytes that came over the network (compressed). */
  encodedBytes: number | null
  fromCache: boolean
  /** Monotonic protocol time (s) of its start, for its duration. */
  timestamp: number
  /** A WebSocket's or event stream's messages, newest last (at most MESSAGE_LIMIT); null for other requests. */
  messages: SocketMessage[] | null
  /** All of its messages, also those no longer kept. */
  messageCount: number
  /** A WebSocket that was closed. */
  closed: boolean
  /** What a route of Claude's did with it (browser_route), e.g. "answered with 500 by route 1". */
  routed: string | null
}

/** A page's requests by session and request id of the protocol (see `requestKey`), and the number of the next. */
export interface NetworkLog {
  network: Map<string, NetworkEntry>
  nextRequest: number
  /** What Claude's routes did with requests the log doesn't know yet, by their key. */
  routed: Map<string, string>
}

/** Notes what a route of Claude's did with a request (by the network's id of it). */
export function markRouted(log: NetworkLog, session: string | undefined, requestId: string, text: string): void {
  const entry = findRequest(log.network, session, requestId)
  if (entry) {
    entry.routed = text
    return
  }
  log.routed.set(requestKey(session, requestId), text)
  while (log.routed.size > 50) log.routed.delete(log.routed.keys().next().value!)
}

/** The page went to another document: its WebSockets are closed, also those the protocol said nothing about. */
export function endSockets(log: NetworkLog): void {
  for (const entry of log.network.values()) {
    if (entry.type === 'WebSocket' && !entry.closed) entry.closed = true
  }
}

function newEntry(log: NetworkLog, key: string, fields: Pick<NetworkEntry, 'requestId' | 'session' | 'method' | 'url' | 'type' | 'startedAt' | 'timestamp'> & Partial<NetworkEntry>): NetworkEntry {
  const routed = log.routed.get(key) ?? null
  log.routed.delete(key)
  const entry: NetworkEntry = {
    id: log.nextRequest++,
    status: null,
    statusText: '',
    failure: null,
    mimeType: null,
    requestHeaders: {},
    responseHeaders: null,
    postData: null,
    hasPostData: false,
    durationMs: null,
    encodedBytes: null,
    fromCache: false,
    messages: null,
    messageCount: 0,
    closed: false,
    routed,
    ...fields,
  }
  log.network.set(key, entry)
  while (log.network.size > NETWORK_LIMIT) log.network.delete(log.network.keys().next().value!)
  return entry
}

function addMessage(entry: NetworkEntry, message: SocketMessage): void {
  entry.messages ??= []
  entry.messages.push({ ...message, data: message.data.length > MAX_MESSAGE_CHARS ? `${message.data.slice(0, MAX_MESSAGE_CHARS - 1)}…` : message.data })
  entry.messageCount++
  if (entry.messages.length > MESSAGE_LIMIT) entry.messages.shift()
}

/** The time of an event of the protocol in ms since the epoch: from its monotonic time, by the request's start. */
function eventTime(entry: NetworkEntry, timestamp: unknown): number {
  const at = Number(timestamp)
  return Number.isFinite(at) && entry.timestamp ? Math.round(entry.startedAt + (at - entry.timestamp) * 1000) : Date.now()
}

/** A frame of a WebSocket as the protocol reports it: opcode 1 is text, 2 binary (base64). */
function socketFrame(entry: NetworkEntry, params: Record<string, unknown>, direction: 'sent' | 'received'): SocketMessage {
  const frame = params.response as { opcode?: number; payloadData?: string }
  const payload = String(frame.payloadData ?? '')
  const binary = frame.opcode === 2
  return {
    at: eventTime(entry, params.timestamp),
    direction,
    binary,
    data: binary ? `${Buffer.from(payload, 'base64').length} bytes` : payload,
  }
}

/**
 * Follows the page's requests through an event of the protocol (`Network.*`). Returns a line for the
 * log when a request worth it failed, else null.
 */
export function networkEvent(log: NetworkLog, method: string, params: Record<string, unknown>, session: string | undefined): string | null {
  switch (method) {
    case 'Network.requestWillBeSent': {
      const request = params.request as { method: string; url: string; headers?: Record<string, string>; postData?: string; hasPostData?: boolean }
      if (request.url.startsWith('data:')) return null
      const key = requestKey(session, params.requestId as string)
      const redirect = params.redirectResponse as { status: number; statusText?: string; headers?: Record<string, string> } | undefined
      const earlier = log.network.get(key)
      if (redirect && earlier) {
        // The same request goes on at another address: the earlier one ends with the redirect.
        earlier.status = redirect.status
        earlier.statusText = redirect.statusText ?? ''
        earlier.responseHeaders = redirect.headers ?? null
        earlier.durationMs = Math.round((Number(params.timestamp) - earlier.timestamp) * 1000)
        log.network.delete(key)
        log.network.set(`${key}#${earlier.id}`, earlier)
      }
      newEntry(log, key, {
        requestId: params.requestId as string,
        session,
        method: request.method,
        url: request.url,
        type: String(params.type ?? 'Other'),
        requestHeaders: request.headers ?? {},
        postData: request.postData ?? null,
        hasPostData: request.hasPostData === true,
        startedAt: typeof params.wallTime === 'number' ? Math.round(params.wallTime * 1000) : Date.now(),
        timestamp: Number(params.timestamp) || 0,
      })
      return null
    }
    case 'Network.webSocketCreated': {
      const url = String(params.url ?? '')
      newEntry(log, requestKey(session, params.requestId as string), {
        requestId: params.requestId as string,
        session,
        method: 'GET',
        url,
        type: 'WebSocket',
        startedAt: Date.now(),
        timestamp: 0,
        messages: [],
      })
      return null
    }
    case 'Network.webSocketWillSendHandshakeRequest': {
      const entry = findRequest(log.network, session, params.requestId as string)
      if (!entry) return null
      const request = params.request as { headers?: Record<string, string> } | undefined
      entry.requestHeaders = request?.headers ?? {}
      if (typeof params.wallTime === 'number') entry.startedAt = Math.round(params.wallTime * 1000)
      entry.timestamp = Number(params.timestamp) || 0
      return null
    }
    case 'Network.webSocketHandshakeResponseReceived': {
      const entry = findRequest(log.network, session, params.requestId as string)
      if (!entry) return null
      const response = params.response as { status: number; statusText?: string; headers?: Record<string, string> }
      entry.status = response.status
      entry.statusText = response.statusText ?? ''
      entry.responseHeaders = response.headers ?? null
      return null
    }
    case 'Network.webSocketFrameSent':
    case 'Network.webSocketFrameReceived': {
      const entry = findRequest(log.network, session, params.requestId as string)
      if (entry) addMessage(entry, socketFrame(entry, params, method === 'Network.webSocketFrameSent' ? 'sent' : 'received'))
      return null
    }
    case 'Network.webSocketFrameError': {
      const entry = findRequest(log.network, session, params.requestId as string)
      if (!entry) return null
      const message = String(params.errorMessage ?? 'error')
      addMessage(entry, { at: eventTime(entry, params.timestamp), direction: 'error', binary: false, data: message })
      // Closed by the page or left by a navigation before it was open: no failure, as with canceled requests.
      if (/handshake was canceled/i.test(message)) return null
      return `WebSocket: ${message} (${shortUrl(entry.url)})`
    }
    case 'Network.webSocketClosed': {
      const entry = findRequest(log.network, session, params.requestId as string)
      if (!entry) return null
      entry.closed = true
      if (entry.timestamp) entry.durationMs = Math.max(0, Math.round((Number(params.timestamp) - entry.timestamp) * 1000))
      return null
    }
    case 'Network.eventSourceMessageReceived': {
      const entry = findRequest(log.network, session, params.requestId as string)
      if (!entry) return null
      const event = params.eventName && params.eventName !== 'message' ? `[${String(params.eventName)}] ` : ''
      addMessage(entry, { at: eventTime(entry, params.timestamp), direction: 'received', binary: false, data: `${event}${String(params.data ?? '')}` })
      return null
    }
    case 'Network.requestServedFromCache': {
      const entry = findRequest(log.network, session, params.requestId as string)
      if (entry) entry.fromCache = true
      return null
    }
    case 'Network.responseReceived': {
      const entry = findRequest(log.network, session, params.requestId as string)
      if (!entry) return null
      const response = params.response as {
        status: number
        statusText?: string
        mimeType?: string
        headers?: Record<string, string>
        fromDiskCache?: boolean
        fromServiceWorker?: boolean
      }
      entry.status = response.status
      entry.statusText = response.statusText ?? ''
      entry.mimeType = response.mimeType ?? null
      entry.responseHeaders = response.headers ?? null
      if (response.fromDiskCache) entry.fromCache = true
      return response.status >= 400 && worthLogging(entry) ? `HTTP ${response.status}: ${entry.method} ${shortUrl(entry.url)}` : null
    }
    case 'Network.loadingFinished': {
      const entry = findRequest(log.network, session, params.requestId as string)
      if (!entry) return null
      entry.encodedBytes = typeof params.encodedDataLength === 'number' ? params.encodedDataLength : null
      entry.durationMs = Math.max(0, Math.round((Number(params.timestamp) - entry.timestamp) * 1000))
      return null
    }
    case 'Network.loadingFailed': {
      const entry = findRequest(log.network, session, params.requestId as string)
      if (!entry || params.canceled) return null
      entry.failure = String(params.errorText ?? 'failed')
      entry.durationMs = Math.max(0, Math.round((Number(params.timestamp) - entry.timestamp) * 1000))
      return worthLogging(entry) ? `${entry.failure}: ${entry.method} ${shortUrl(entry.url)}` : null
    }
  }
  return null
}

/** Only failures of pages and of the requests scripts make are worth a line; not every missing image. */
function worthLogging(entry: NetworkEntry): boolean {
  return entry.type === 'Document' || entry.type === 'XHR' || entry.type === 'Fetch'
}

export function shortUrl(url: string): string {
  return url.length > 120 ? `${url.slice(0, 119)}…` : url
}

/** The session's key of a request: request ids are only unique within one DevTools session. */
function requestKey(session: string | undefined, requestId: string): string {
  return `${session ?? ''}|${requestId}`
}

/**
 * The entry of a request an event of `session` is about. The document of a frame in a process of
 * its own starts in the session around the frame and is loaded in the frame's own (its id is unique):
 * then its entry follows it there, where its body is.
 */
export function findRequest(network: Map<string, NetworkEntry>, session: string | undefined, requestId: string): NetworkEntry | undefined {
  const entry = network.get(requestKey(session, requestId))
  if (entry || session === undefined) return entry
  for (const other of network.values()) {
    if (other.requestId !== requestId || other.type !== 'Document') continue
    other.session = session
    return other
  }
  return undefined
}
