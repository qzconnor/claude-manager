import { describe, expect, it } from 'vitest'
import { permissionDecision } from './browser-permissions'

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
})
