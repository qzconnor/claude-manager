import { describe, expect, it } from 'vitest'
import { findRequest, isEmulating, type NetworkEntry } from './browser-control'

function entry(change: Partial<NetworkEntry>): NetworkEntry {
  return {
    id: 1,
    requestId: 'R1',
    session: undefined,
    method: 'GET',
    url: 'http://localhost/',
    type: 'Fetch',
    status: null,
    statusText: '',
    failure: null,
    mimeType: null,
    requestHeaders: {},
    responseHeaders: null,
    postData: null,
    hasPostData: false,
    startedAt: 0,
    durationMs: null,
    encodedBytes: null,
    fromCache: false,
    timestamp: 0,
    ...change,
  }
}

describe('findRequest', () => {
  it('finds a request by its session and id', () => {
    const fetch = entry({ requestId: '7.1', session: 'S' })
    const network = new Map([['S|7.1', fetch]])
    expect(findRequest(network, 'S', '7.1')).toBe(fetch)
    expect(findRequest(network, undefined, '7.1')).toBeUndefined()
  })

  it('follows the document of a frame into the session of the frame, where it finishes loading', () => {
    const document = entry({ requestId: 'LOADER', type: 'Document' })
    const network = new Map([['|LOADER', document]])
    expect(findRequest(network, 'FRAME', 'LOADER')).toBe(document)
    expect(document.session).toBe('FRAME')
    // Other requests of the page are not taken for those of a frame.
    network.set('|9.2', entry({ requestId: '9.2' }))
    expect(findRequest(network, 'FRAME', '9.2')).toBeUndefined()
  })
})

describe('isEmulating', () => {
  it('tells whether the page pretends anything', () => {
    const none = { colorScheme: null, reducedMotion: false, network: null, cpuSlowdown: null, locale: null, timezone: null }
    expect(isEmulating(none)).toBe(false)
    expect(isEmulating({ ...none, timezone: 'Asia/Tokyo' })).toBe(true)
    expect(isEmulating({ ...none, reducedMotion: true })).toBe(true)
  })
})
