/** The requests of a page, followed through the DevTools protocol's events (browser_network_requests). */

export const NETWORK_LIMIT = 300

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
}

/** A page's requests by session and request id of the protocol (see `requestKey`), and the number of the next. */
export interface NetworkLog {
  network: Map<string, NetworkEntry>
  nextRequest: number
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
      log.network.set(key, {
        id: log.nextRequest++,
        requestId: params.requestId as string,
        session,
        method: request.method,
        url: request.url,
        type: String(params.type ?? 'Other'),
        status: null,
        statusText: '',
        failure: null,
        mimeType: null,
        requestHeaders: request.headers ?? {},
        responseHeaders: null,
        postData: request.postData ?? null,
        hasPostData: request.hasPostData === true,
        startedAt: typeof params.wallTime === 'number' ? Math.round(params.wallTime * 1000) : Date.now(),
        durationMs: null,
        encodedBytes: null,
        fromCache: false,
        timestamp: Number(params.timestamp) || 0,
      })
      while (log.network.size > NETWORK_LIMIT) log.network.delete(log.network.keys().next().value!)
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
