import { describe, expect, it } from 'vitest'
import { originOf, permissionDecision } from './browser-permissions'

describe('permissionDecision', () => {
  it('answers only for permissions Claude set', () => {
    expect(permissionDecision(undefined, 'notifications')).toBeNull()
    expect(permissionDecision({ notifications: 'granted' }, 'notifications')).toBe(true)
    expect(permissionDecision({ notifications: 'denied' }, 'notifications')).toBe(false)
    expect(permissionDecision({ notifications: 'granted' }, 'geolocation')).toBeNull()
    expect(permissionDecision({ 'clipboard-read': 'granted' }, 'clipboard-read')).toBe(true)
    expect(permissionDecision({ camera: 'granted' }, 'midi')).toBeNull()
  })

  it('grants media only when every kind asked for is granted', () => {
    expect(permissionDecision({ camera: 'granted' }, 'media', ['video'])).toBe(true)
    expect(permissionDecision({ camera: 'granted' }, 'media', ['video', 'audio'])).toBe(false)
    expect(permissionDecision({ camera: 'granted', microphone: 'granted' }, 'media', ['video', 'audio'])).toBe(true)
    expect(permissionDecision({ microphone: 'denied' }, 'media', ['audio'])).toBe(false)
    expect(permissionDecision({ geolocation: 'granted' }, 'media', ['video'])).toBeNull()
    expect(permissionDecision({ camera: 'granted' }, 'media', [])).toBeNull()
  })

  it('grants nothing to another site, but refuses there too', () => {
    expect(permissionDecision({ notifications: 'granted' }, 'notifications', [], false)).toBeNull()
    expect(permissionDecision({ camera: 'granted' }, 'media', ['video'], false)).toBeNull()
    expect(permissionDecision({ notifications: 'denied' }, 'notifications', [], false)).toBe(false)
    expect(permissionDecision({ camera: 'granted', microphone: 'denied' }, 'media', ['video', 'audio'], false)).toBe(false)
  })
})

describe('originOf', () => {
  it('gives the origin of a URL or an origin', () => {
    expect(originOf('https://example.com/a?b#c')).toBe('https://example.com')
    expect(originOf('https://example.com')).toBe('https://example.com')
    expect(originOf('http://localhost:5173/x')).toBe('http://localhost:5173')
  })

  it('gives none for pages without one', () => {
    expect(originOf('about:blank')).toBeNull()
    expect(originOf('data:text/html,hi')).toBeNull()
    expect(originOf('')).toBeNull()
    expect(originOf(undefined)).toBeNull()
    expect(originOf('not a url')).toBeNull()
  })
})
