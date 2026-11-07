import { describe, expect, it } from 'vitest'
import { NO_EMULATION } from '@shared/browser'
import { findRequest, type NetworkEntry } from './network-log'
import { effectivePermissions, isEmulating } from './page-emulation'

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
    messages: null,
    messageCount: 0,
    closed: false,
    routed: null,
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
    expect(isEmulating(NO_EMULATION)).toBe(false)
    expect(isEmulating({ ...NO_EMULATION, timezone: 'Asia/Tokyo' })).toBe(true)
    expect(isEmulating({ ...NO_EMULATION, reducedMotion: true })).toBe(true)
    expect(isEmulating({ ...NO_EMULATION, geolocation: { latitude: 1, longitude: 2, accuracy: 50 } })).toBe(true)
    expect(isEmulating({ ...NO_EMULATION, permissions: { notifications: 'denied' } })).toBe(true)
  })
})

describe('effectivePermissions', () => {
  it('grants the location with a place of Claude’s, unless Claude refused it', () => {
    const place = { latitude: 48.85, longitude: 2.35, accuracy: 50 }
    expect(effectivePermissions(null)).toEqual({})
    expect(effectivePermissions({ ...NO_EMULATION, geolocation: place })).toEqual({ geolocation: 'granted' })
    expect(effectivePermissions({ ...NO_EMULATION, geolocation: place, permissions: { geolocation: 'denied', camera: 'granted' } })).toEqual({
      geolocation: 'denied',
      camera: 'granted',
    })
  })
})
