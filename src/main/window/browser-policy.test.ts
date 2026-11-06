import type { WebPreferences } from 'electron'
import { describe, expect, it } from 'vitest'
import { matchShortcut } from '@shared/shortcuts'
import { browserUserAgent, faviconType, hardenWebview, mobileUserAgent, toShortcutKey } from './browser-policy'

describe('hardenWebview', () => {
  it('takes Node.js and the preload away and puts the page into the browser profile', () => {
    const prefs: WebPreferences = { preload: 'C:/app/preload.js', nodeIntegration: true, contextIsolation: false, sandbox: false, webSecurity: false }
    const params: Record<string, string> = { src: 'https://example.com', partition: 'persist:other' }
    expect(hardenWebview(prefs, params)).toBe(true)
    expect(prefs).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, partition: 'persist:browser' })
    expect(prefs.preload).toBeUndefined()
    expect(params.partition).toBe('persist:browser')
  })

  it('refuses views that start at an address the browser may not show', () => {
    expect(hardenWebview({}, { src: 'file:///C:/Windows/win.ini' })).toBe(false)
    expect(hardenWebview({}, { src: 'javascript:alert(1)' })).toBe(false)
    expect(hardenWebview({}, { src: 'about:blank' })).toBe(true)
    expect(hardenWebview({}, {})).toBe(true)
  })
})

describe('mobileUserAgent', () => {
  it("turns the browser's agent into a phone's of the same Chrome", () => {
    const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.49 Safari/537.36'
    const { userAgent, userAgentMetadata } = mobileUserAgent(desktop)
    expect(userAgent).toBe(
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.49 Mobile Safari/537.36',
    )
    expect(userAgentMetadata).toMatchObject({ platform: 'Android', mobile: true })
  })

  it('still gives a phone agent for an agent it does not know', () => {
    expect(mobileUserAgent('Something').userAgent).toContain('Mobile Safari')
  })
})

describe('browserUserAgent', () => {
  it('leaves Electron and the app out', () => {
    const electron =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) claude-manager/1.25.0 Chrome/146.0.7680.65 Electron/45.1.0 Safari/537.36'
    expect(browserUserAgent(electron)).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.65 Safari/537.36',
    )
    expect(browserUserAgent('Something else')).toBe('Something else')
  })
})

describe('toShortcutKey', () => {
  it('lets the shortcut matchers read the keys of a page', () => {
    const key = (input: { key: string; code: string; control?: boolean; alt?: boolean; shift?: boolean; type?: string }) =>
      toShortcutKey({ type: 'keyDown', control: false, alt: false, shift: false, meta: false, ...input })
    expect(matchShortcut(key({ key: 'Tab', code: 'Tab', control: true }))).toEqual({ action: 'next-tab' })
    expect(matchShortcut(key({ key: 'ArrowLeft', code: 'ArrowLeft', alt: true }))).toEqual({ action: 'focus-pane', direction: 'left' })
    expect(matchShortcut(key({ key: 'Tab', code: 'Tab', control: true, type: 'keyUp' }))).toBeNull()
  })
})

describe('faviconType', () => {
  const bytes = (...values: number[]) => new Uint8Array(values)
  const text = (value: string) => new TextEncoder().encode(value)

  it('knows the image by its first bytes, whatever the server called it', () => {
    expect(faviconType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe('image/png')
    expect(faviconType(bytes(0x00, 0x00, 0x01, 0x00, 0x01, 0x00))).toBe('image/x-icon')
    expect(faviconType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif')
    expect(faviconType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(faviconType(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(faviconType(text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml')
  })

  it('refuses pages and anything else that is no image', () => {
    expect(faviconType(text('<!doctype html><html><body><svg></svg></body></html>'))).toBeNull()
    expect(faviconType(text('Not Found'))).toBeNull()
    expect(faviconType(text('RIFF\0\0\0\0WAVEfmt '))).toBeNull()
    expect(faviconType(bytes())).toBeNull()
  })
})
