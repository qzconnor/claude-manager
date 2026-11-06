import { describe, expect, it } from 'vitest'
import { sessionKey } from './useSessionSearch'

describe('sessionKey', () => {
  it('tells the same session id in two accounts apart', () => {
    expect(sessionKey('a', 'session-1')).toBe('a:session-1')
    expect(sessionKey('a', 'session-1')).not.toBe(sessionKey('b', 'session-1'))
  })
})
