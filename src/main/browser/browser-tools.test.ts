import { describe, expect, it } from 'vitest'
import { NO_EMULATION } from '@shared/browser'
import { describeEmulation, mergePermissions, parseEmulation } from './browser-tools/emulation-args'
import { bodyText, formatBytes, headerLines, requestBodyText } from './browser-tools/network-format'
import { formatMs, formatPerformance, type PerformanceReport } from './browser-tools/performance'
import { cookieLine, type Cookie } from './browser-tools/storage'

describe('parseEmulation', () => {
  it('takes only what is given', () => {
    expect(parseEmulation({ colorScheme: 'dark', network: 'slow-3g' })).toEqual({
      reset: false,
      change: { colorScheme: 'dark', network: 'slow-3g' },
      permissions: {},
    })
  })

  it('takes a place as latitude, longitude and accuracy, and "" for none', () => {
    expect(parseEmulation({ geolocation: '48.8566, 2.3522' }).change.geolocation).toEqual({ latitude: 48.8566, longitude: 2.3522, accuracy: 50 })
    expect(parseEmulation({ geolocation: '-33.86,151.21,10' }).change.geolocation).toEqual({ latitude: -33.86, longitude: 151.21, accuracy: 10 })
    expect(parseEmulation({ geolocation: '' }).change.geolocation).toBeNull()
    expect(() => parseEmulation({ geolocation: '95,10' })).toThrow(/latitude,longitude/)
    expect(() => parseEmulation({ geolocation: 'Berlin' })).toThrow(/latitude,longitude/)
  })

  it('takes permissions one by one; default gives one back to the browser', () => {
    const parsed = parseEmulation({ permissions: { notifications: 'granted', camera: 'default' } })
    expect(parsed.permissions).toEqual({ notifications: 'granted', camera: 'default' })
    expect(mergePermissions({ camera: 'granted', microphone: 'denied' }, parsed.permissions)).toEqual({ notifications: 'granted', microphone: 'denied' })
    expect(() => parseEmulation({ permissions: { usb: 'granted' } })).toThrow(/permissions takes/)
    expect(() => parseEmulation({ permissions: { camera: 'yes' } })).toThrow(/granted, denied, default/)
  })

  it('turns "system", "online", a slowdown of 1 and empty strings into the way back', () => {
    expect(parseEmulation({ colorScheme: 'system', network: 'online', cpuSlowdown: 1, locale: '', timezone: '' }).change).toEqual({
      colorScheme: null,
      network: null,
      cpuSlowdown: null,
      locale: null,
      timezone: null,
    })
  })

  it('accepts language tags with underscores and checks time zones', () => {
    expect(parseEmulation({ locale: 'de_DE' }).change.locale).toBe('de-DE')
    expect(parseEmulation({ timezone: 'America/New_York' }).change.timezone).toBe('America/New_York')
    expect(() => parseEmulation({ timezone: 'Mars/Olympus' })).toThrow(/IANA/)
    expect(() => parseEmulation({ locale: 'not a locale' })).toThrow(/language tag/)
  })

  it('wants something to do', () => {
    expect(() => parseEmulation({})).toThrow(/at least one/)
    expect(parseEmulation({ reset: true, colorScheme: 'dark' })).toEqual({ reset: true, change: {}, permissions: {} })
  })

  it('checks the range of the slowdown', () => {
    expect(() => parseEmulation({ cpuSlowdown: 50 })).toThrow(/1 to 20/)
    expect(parseEmulation({ cpuSlowdown: 4 }).change.cpuSlowdown).toBe(4)
  })
})

describe('describeEmulation', () => {
  it('names everything the page pretends', () => {
    expect(
      describeEmulation({
        colorScheme: 'dark',
        reducedMotion: true,
        network: 'offline',
        cpuSlowdown: 4,
        locale: 'ja-JP',
        timezone: 'Asia/Tokyo',
        geolocation: { latitude: 35.68, longitude: 139.69, accuracy: 50 },
        permissions: { notifications: 'denied' },
      }),
    ).toBe(
      'dark color scheme, reduced motion, no network (offline), CPU 4× slower, locale ja-JP, time zone Asia/Tokyo, location 35.68,139.69 (±50 m, permission granted), notifications permission denied',
    )
    expect(describeEmulation(NO_EMULATION)).toBe('')
  })
})

describe('headerLines', () => {
  it('leaves out the values of cookies and authorization, not their names', () => {
    const lines = headerLines({
      'content-type': 'application/json',
      Cookie: 'session=abc123; theme=dark',
      authorization: 'Bearer secret-token',
      'set-cookie': 'session=xyz; Path=/\ncsrf=1; Path=/',
    })
    expect(lines).toEqual([
      '  content-type: application/json',
      '  Cookie: (2 cookie(s): session, theme; values hidden)',
      '  authorization: Bearer (hidden)',
      '  set-cookie: (sets session, csrf; values hidden)',
    ])
    expect(lines.join('\n')).not.toMatch(/abc123|secret-token|xyz/)
  })

  it('says so when there are none', () => {
    expect(headerLines({})).toEqual(['  (none)'])
  })
})

describe('bodyText', () => {
  it('indents JSON and cuts long bodies', () => {
    expect(bodyText('{"a":1}', 'application/json')).toBe('{\n  "a": 1\n}')
    expect(bodyText('', 'text/plain')).toBe('(empty)')
    const long = bodyText('x'.repeat(25_000), 'text/plain')
    expect(long).toContain('(cut: 25000 characters in all)')
    expect(long.length).toBeLessThan(21_000)
  })

  it('leaves text that only looks like JSON as it is', () => {
    expect(bodyText('{ not json', 'text/plain')).toBe('{ not json')
  })
})

describe('requestBodyText', () => {
  it('hides passwords in a form, keeps the other fields', () => {
    expect(requestBodyText('user=ann&password=hunter2&remember=1', 'application/x-www-form-urlencoded')).toBe(
      'user=ann&password=•••• (hidden)&remember=1',
    )
  })

  it('hides password-like fields in JSON, also nested', () => {
    const text = requestBodyText('{"email":"a@b.c","auth":{"passphrase":"x","newPassword":"y"},"pin":1234}', 'application/json')
    expect(text).not.toContain('"x"')
    expect(text).not.toContain('"y"')
    expect(text).not.toContain('1234')
    expect(text).toContain('a@b.c')
    expect(text).toContain('"newPassword": "•••• (hidden)"')
  })

  it('hides password fields of a multipart form', () => {
    const body = '--b\r\nContent-Disposition: form-data; name="user"\r\n\r\nann\r\n--b\r\nContent-Disposition: form-data; name="password"\r\n\r\nhunter2\r\n--b--'
    const text = requestBodyText(body, 'multipart/form-data; boundary=b')
    expect(text).toContain('ann')
    expect(text).not.toContain('hunter2')
  })

  it('leaves bodies without such fields as bodyText shows them', () => {
    expect(requestBodyText('{"a":1}', 'application/json')).toBe(bodyText('{"a":1}', 'application/json'))
    expect(requestBodyText('q=pass', 'application/x-www-form-urlencoded')).toBe('q=pass')
  })
})

describe('formatting', () => {
  it('writes sizes and times for people', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(formatMs(840)).toBe('840 ms')
    expect(formatMs(1234)).toBe('1.23 s')
  })
})

describe('formatPerformance', () => {
  const report: PerformanceReport = {
    url: 'http://localhost:5173/',
    navigation: { type: 'reload', ttfb: 40, domContentLoaded: 420, load: 900, transfer: 2048, protocol: 'http/1.1' },
    fcp: 380,
    lcp: { time: 3100, element: 'img#hero', url: 'http://localhost:5173/hero.jpg' },
    cls: 0.31,
    longTasks: { count: 2, tbt: 150, longest: 120 },
    inp: null,
    resources: [
      { name: 'http://localhost:5173/app.js', type: 'script', duration: 300, size: 200_000 },
      { name: 'http://localhost:5173/hero.jpg', type: 'img', duration: 700, size: 900_000 },
      { name: 'https://cdn.example/font.woff2', type: 'css', duration: 100, size: 0 },
    ],
  }

  it('rates the vitals and lists the slowest and largest requests', () => {
    const text = formatPerformance(report, { JSHeapUsedSize: 8 * 1024 * 1024, Nodes: 1200, LayoutCount: 9, LayoutDuration: 0.02 }, {
      reloaded: true,
      coldCache: false,
      emulation: { ...NO_EMULATION, network: 'slow-3g', cpuSlowdown: 4 },
    })
    expect(text).toContain('Performance of http://localhost:5173/ (loaded again; emulating slow-3g network, CPU 4× slower):')
    expect(text).toContain('- Largest contentful paint: 3.10 s (needs improvement) — img#hero http://localhost:5173/hero.jpg')
    expect(text).toContain('- Cumulative layout shift: 0.31 (poor)')
    expect(text).toContain('- Total blocking time: 150 ms (good), 2 long task(s), the longest 120 ms')
    expect(text).toContain('- Interaction to next paint: none yet')
    expect(text).toContain('- Requests: 3, 1.0 MB over the network: img 1 (879 KB), script 1 (195 KB), css 1 (0 B)')
    expect(text.indexOf('700 ms img')).toBeLessThan(text.indexOf('300 ms script'))
    expect(text).toContain('- JS heap 8.0 MB, 1200 DOM nodes\n- While loading: 9 layouts (20 ms)')
  })

  it('leaves out the counters without a reload: they start with the measurement', () => {
    const text = formatPerformance(report, { JSHeapUsedSize: 8 * 1024 * 1024, Nodes: 1200, LayoutCount: 0, ScriptDuration: 0 }, {
      reloaded: false,
      coldCache: false,
      emulation: null,
    })
    expect(text).toContain('(as it is now, not loaded again)')
    expect(text).toContain('- JS heap 8.0 MB, 1200 DOM nodes')
    expect(text).not.toContain('layouts')
    expect(text).not.toContain('While loading')
  })
})

describe('cookieLine', () => {
  const cookie = (over: Partial<Cookie>): Cookie => ({
    name: 'sid',
    value: 'abc123',
    domain: '.example.com',
    path: '/',
    expires: 0,
    size: 9,
    httpOnly: false,
    secure: true,
    session: true,
    ...over,
  })

  it('shows the value of a cookie scripts can read', () => {
    expect(cookieLine(cookie({}), 200)).toBe('- sid=abc123 (domain .example.com, secure, session)')
  })

  it('withholds the value of an httpOnly cookie, a login mostly', () => {
    const line = cookieLine(cookie({ name: 'user_session', value: 'secret-token', httpOnly: true, sameSite: 'Lax' }), 20_000)
    expect(line).toBe('- user_session (value withheld, 12 characters) (domain .example.com, httpOnly, secure, SameSite=Lax, session)')
    expect(line).not.toContain('secret-token')
  })
})
