import { describe, expect, it } from 'vitest'
import { NO_EMULATION } from '@shared/browser'
import { emulationCode, requestLine, socketMessages } from './browser-tools/debugging'
import { formatAudit } from './browser-tools/inspection'
import type { NetworkEntry } from './network-log'

function entry(change: Partial<NetworkEntry>): NetworkEntry {
  return {
    id: 7,
    requestId: 'R',
    session: undefined,
    method: 'GET',
    url: 'http://localhost/api',
    type: 'Fetch',
    status: 200,
    statusText: '',
    failure: null,
    mimeType: null,
    requestHeaders: {},
    responseHeaders: null,
    postData: null,
    hasPostData: false,
    startedAt: 1000,
    durationMs: 12,
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

describe('requestLine', () => {
  it('names routes, frames and the messages of a WebSocket', () => {
    expect(requestLine(entry({ routed: 'answered with 500 by route 1', status: 500 }))).toBe('#7 GET http://localhost/api → 500 [Fetch] 12 ms (answered with 500 by route 1)')
    expect(requestLine(entry({ type: 'WebSocket', url: 'ws://x', status: 101, durationMs: null, messages: [], messageCount: 4 }))).toBe(
      '#7 GET ws://x → 101 [WebSocket] 4 message(s), open',
    )
  })
})

describe('socketMessages', () => {
  it('shows the last messages with their direction and time', () => {
    const socket = entry({
      type: 'WebSocket',
      messageCount: 3,
      messages: [
        { at: 1500, direction: 'sent', binary: false, data: 'ping' },
        { at: 2250, direction: 'received', binary: true, data: '8 bytes' },
        { at: 3000, direction: 'error', binary: false, data: 'closed' },
      ],
    })
    expect(socketMessages(socket, 2)).toEqual(['Messages (3, the last 2; → sent, ← received):', '← +1.250 s (binary, 8 bytes)', '✕ +2.000 s closed'])
    expect(socketMessages(entry({ messages: [] }), 5)).toEqual(['Messages: none yet.'])
  })
})

describe('emulationCode', () => {
  it('writes what Playwright can change while the test runs, and notes the rest', () => {
    const next = {
      ...NO_EMULATION,
      colorScheme: 'dark' as const,
      geolocation: { latitude: 48.85, longitude: 2.35, accuracy: 50 },
      permissions: { notifications: 'granted' as const },
      locale: 'fr-FR',
    }
    expect(emulationCode(NO_EMULATION, next)).toEqual([
      "await page.emulateMedia({ colorScheme: 'dark' })",
      'await page.context().setGeolocation({ latitude: 48.85, longitude: 2.35, accuracy: 50 })',
      "await page.context().grantPermissions(['geolocation', 'notifications'])",
      "// Claude switched the page to locale: 'fr-FR' here: set it in test.use({ locale: 'fr-FR' }).",
    ])
    expect(emulationCode(next, NO_EMULATION)).toEqual(['await page.emulateMedia({ colorScheme: null })', 'await page.context().clearPermissions()'])
  })
})

describe('formatAudit', () => {
  it('lists errors first, each rule with its count', () => {
    const text = formatAudit(
      [
        { rule: 'heading-order', severity: 'warning', line: 'heading "Prices" [ref=e4] [level=4]', detail: 'A heading of level 4 follows one of level 2.' },
        { rule: 'image-alt', severity: 'error', line: 'img [ref=e2]', detail: 'The image has no alt text.' },
        { rule: 'html-lang', severity: 'error', line: null, detail: 'The <html> element has no lang attribute.' },
      ],
      { 'heading-order': 1, 'image-alt': 3, 'html-lang': 1 },
    )
    expect(text.split('\n')).toEqual([
      '5 problem(s) in 3 rule(s):',
      '',
      'Images without alt text [error, 3]:',
      '- img [ref=e2]',
      '  The image has no alt text.',
      '- … 2 more',
      '',
      'Language of the page [error, 1]:',
      '- The <html> element has no lang attribute.',
      '',
      'Skipped heading levels [warning, 1]:',
      '- heading "Prices" [ref=e4] [level=4]',
      '  A heading of level 4 follows one of level 2.',
    ])
  })
})
