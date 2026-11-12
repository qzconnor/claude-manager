import { describe, expect, it } from 'vitest'
import {
  addressOf,
  addressToUrl,
  BLANK_PAGE,
  emulationLabels,
  fallbackTitle,
  isBrowsableUrl,
  NO_EMULATION,
  routeLabel,
  trimLog,
} from './browser'

describe('trimLog', () => {
  const lines = (spec: string) => [...spec].map((c, i) => ({ id: i, sensitive: c === 's' }))
  const ids = (log: { id: number }[]) => log.map((line) => line.id)

  it('drops the oldest lines beyond the limit', () => {
    const log = lines('pppp')
    trimLog(log, 2)
    expect(ids(log)).toEqual([2, 3])
  })

  it('keeps the sensitive lines and drops the plain ones first', () => {
    const log = lines('spsps')
    trimLog(log, 3)
    expect(ids(log)).toEqual([0, 2, 4])
  })

  it('drops the oldest sensitive lines when nothing else is left', () => {
    const log = lines('sss')
    trimLog(log, 2)
    expect(ids(log)).toEqual([1, 2])
  })

  it('leaves a log within the limit alone', () => {
    const log = lines('ps')
    trimLog(log, 2)
    expect(ids(log)).toEqual([0, 1])
  })
})

describe('addressToUrl', () => {
  it('takes addresses as typed and adds the scheme when it is missing', () => {
    expect(addressToUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(addressToUrl('  http://example.com ')).toBe('http://example.com')
    expect(addressToUrl('example.com')).toBe('https://example.com')
    expect(addressToUrl('docs.example.co.uk/path#x')).toBe('https://docs.example.co.uk/path#x')
    expect(addressToUrl('münchen.de')).toBe('https://münchen.de')
  })

  it('opens local hosts over http', () => {
    expect(addressToUrl('localhost')).toBe('http://localhost')
    expect(addressToUrl('localhost:5173/app')).toBe('http://localhost:5173/app')
    expect(addressToUrl('192.168.0.2:8080')).toBe('http://192.168.0.2:8080')
    expect(addressToUrl('[::1]:3000')).toBe('http://[::1]:3000')
  })

  it('searches for anything else', () => {
    expect(addressToUrl('claude code')).toBe('https://www.google.com/search?q=claude%20code')
    expect(addressToUrl('vue')).toBe('https://www.google.com/search?q=vue')
    expect(addressToUrl('file:///C:/Windows')).toBe('https://www.google.com/search?q=file%3A%2F%2F%2FC%3A%2FWindows')
    expect(addressToUrl('javascript:alert(1)')).toBe('https://www.google.com/search?q=javascript%3Aalert(1)')
  })

  it('opens the empty page for nothing', () => {
    expect(addressToUrl('   ')).toBe(BLANK_PAGE)
    expect(addressToUrl('about:blank')).toBe(BLANK_PAGE)
  })
})

describe('isBrowsableUrl', () => {
  it('allows http(s) and the empty page only', () => {
    expect(isBrowsableUrl('https://example.com')).toBe(true)
    expect(isBrowsableUrl('http://localhost:3000')).toBe(true)
    expect(isBrowsableUrl(BLANK_PAGE)).toBe(true)
    for (const url of ['file:///C:/x', 'javascript:alert(1)', 'chrome://gpu', 'devtools://devtools', 'data:text/html,x', 'nope']) {
      expect(isBrowsableUrl(url)).toBe(false)
    }
    expect(isBrowsableUrl(`https://example.com/${'a'.repeat(9000)}`)).toBe(false)
  })
})

describe('addressOf and fallbackTitle', () => {
  it('shows nothing and the default title for the empty page', () => {
    expect(addressOf(BLANK_PAGE)).toBe('')
    expect(addressOf(null)).toBe('')
    expect(addressOf('https://a.de/')).toBe('https://a.de/')
    expect(fallbackTitle(BLANK_PAGE)).toBe('Neuer Tab')
    expect(fallbackTitle('https://docs.example.com:8443/x')).toBe('docs.example.com:8443')
  })
})

describe('emulationLabels', () => {
  it('names what Claude has the page pretend, in German', () => {
    expect(
      emulationLabels({
        colorScheme: 'dark',
        reducedMotion: true,
        network: 'slow-3g',
        cpuSlowdown: 4,
        locale: 'en-US',
        timezone: 'America/New_York',
        geolocation: { latitude: 52.52, longitude: 13.4, accuracy: 50 },
        permissions: { notifications: 'granted', camera: 'denied' },
      }),
    ).toEqual([
      'Dunkel',
      'Weniger Bewegung',
      'Langsames 3G',
      'CPU 4× langsamer',
      'en-US',
      'America/New_York',
      'Standort 52.52, 13.40',
      'Benachrichtigungen erlaubt',
      'Kamera verweigert',
    ])
    expect(emulationLabels(NO_EMULATION)).toEqual([])
  })
})

describe('routeLabel', () => {
  const route = { id: 1, pattern: '*/api/users*', method: null, action: 'fulfill' as const, status: 500, delayMs: 0, hits: 0, timesLeft: null }
  it('names what a route does with the requests it takes', () => {
    expect(routeLabel(route)).toBe('*/api/users* → 500')
    expect(routeLabel({ ...route, method: 'POST', status: null, delayMs: 2000 })).toBe('POST */api/users* → 200 +2000 ms')
    expect(routeLabel({ ...route, action: 'fail', pattern: 'ads.example.com' })).toBe('ads.example.com blockiert')
    expect(routeLabel({ ...route, action: 'delay', delayMs: 3000 })).toBe('*/api/users* +3000 ms')
  })
})
