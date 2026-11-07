import { describe, expect, it } from 'vitest'
import { clickOptions, dialogCode, evaluateCode, generateTest, type LocatorInfo, locatorCode, routeCode, str } from './browser-tools/test-code'

function info(change: Partial<LocatorInfo>): LocatorInfo {
  return { role: '', name: '', testId: '', label: '', placeholder: '', text: '', same: 1, exact: 1, index: 0, css: 'div > span', ...change }
}

describe('str', () => {
  it('writes a string for TypeScript in single quotes', () => {
    expect(str("it's")).toBe("'it\\'s'")
    expect(str('a\\b\nc')).toBe("'a\\\\b\\nc'")
  })
})

describe('locatorCode', () => {
  it('prefers a test id, then role and name', () => {
    expect(locatorCode(info({ testId: 'save', role: 'button', name: 'Save' }))).toBe("page.getByTestId('save')")
    expect(locatorCode(info({ role: 'button', name: 'Save' }))).toBe("page.getByRole('button', { name: 'Save' })")
  })

  it('makes the name exact or picks the element when others share it', () => {
    expect(locatorCode(info({ role: 'button', name: 'Save', same: 2, exact: 1 }))).toBe("page.getByRole('button', { name: 'Save', exact: true })")
    expect(locatorCode(info({ role: 'link', name: 'More', same: 3, exact: 3, index: 2 }))).toBe("page.getByRole('link', { name: 'More', exact: true }).nth(2)")
  })

  it('falls back to label, placeholder, text and CSS', () => {
    expect(locatorCode(info({ role: 'textbox', label: 'Email' }))).toBe("page.getByLabel('Email')")
    expect(locatorCode(info({ placeholder: 'Search' }))).toBe("page.getByPlaceholder('Search')")
    expect(locatorCode(info({ role: 'clickable', text: 'Open card' }))).toBe("page.getByText('Open card', { exact: true })")
    expect(locatorCode(info({ role: 'button' }))).toBe("page.locator('div > span')")
    expect(locatorCode(info({}))).toBe("page.locator('div > span')")
  })

  it('reaches into a frame', () => {
    expect(locatorCode(info({ role: 'button', name: 'Pay' }), true)).toBe("page.frameLocator('iframe').first().getByRole('button', { name: 'Pay' })")
  })
})

describe('clickOptions and dialogCode', () => {
  it('leaves out what Playwright does anyway', () => {
    expect(clickOptions({ button: 'left' })).toBe('')
    expect(clickOptions({ button: 'right', modifiers: ['Shift'] })).toBe("{ button: 'right', modifiers: ['Shift'] }")
  })

  it('answers dialogs as the browser did', () => {
    expect(dialogCode('OK')).toBe("page.once('dialog', (dialog) => dialog.accept())")
    expect(dialogCode('Cancel')).toBe("page.once('dialog', (dialog) => dialog.dismiss())")
    expect(dialogCode('"Ada"')).toBe("page.once('dialog', (dialog) => dialog.accept('Ada'))")
  })
})

describe('routeCode', () => {
  const base = { pattern: '/api/users', method: null, action: 'fulfill' as const, status: 500, delayMs: 0, timesLeft: null, body: '{"error":1}', headers: { 'Content-Type': 'application/json' }, error: null }

  it('answers like the route', () => {
    expect(routeCode(base)).toEqual([
      'await page.route(/^.*\\/api\\/users.*$/, async (route) => {',
      `  await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":1}' })`,
      '})',
    ])
  })

  it('checks the method, waits, fails and ends after its times', () => {
    expect(routeCode({ ...base, method: 'POST', action: 'fail', error: 'offline', delayMs: 300, timesLeft: 2 })).toEqual([
      'await page.route(/^.*\\/api\\/users.*$/, async (route) => {',
      "  if (route.request().method() !== 'POST') return route.fallback()",
      '  await new Promise((resolve) => setTimeout(resolve, 300))',
      "  await route.abort('internetdisconnected')",
      '}, { times: 2 })',
    ])
  })
})

describe('evaluateCode', () => {
  it('passes functions as they are and wraps expressions', () => {
    expect(evaluateCode('() => document.title')).toBe('await page.evaluate(() => document.title)')
    expect(evaluateCode('async () => { await x() }')).toBe('await page.evaluate(async () => { await x() })')
    expect(evaluateCode('document.title')).toBe('await page.evaluate(() => (document.title))')
  })
})

describe('generateTest', () => {
  it('starts at the first page and names a change of tabs', () => {
    const code = generateTest(
      [
        { browserId: 'A', url: 'http://localhost:5173/', code: ["await page.getByRole('button', { name: 'Add' }).click()"] },
        { browserId: 'A', url: 'http://localhost:5173/', code: ["await expect(page.getByText('Added').first()).toBeVisible()"] },
        { browserId: 'B', url: 'https://example.com/', code: ["await page.goto('https://example.com/docs')"] },
      ],
      'adds an item',
    )
    expect(code).toBe(
      [
        "import { test, expect } from '@playwright/test'",
        '',
        "test('adds an item', async ({ page }) => {",
        "  await page.goto('http://localhost:5173/')",
        "  await page.getByRole('button', { name: 'Add' }).click()",
        "  await expect(page.getByText('Added').first()).toBeVisible()",
        '',
        '  // Claude went on in another browser tab here.',
        "  await page.goto('https://example.com/docs')",
        '})',
        '',
      ].join('\n'),
    )
  })

  it('imports expect only when it is used', () => {
    expect(generateTest([{ browserId: 'A', url: 'about:blank', code: ["await page.goto('http://x/')"] }], 't')).toMatch(/^import \{ test \} from/)
  })
})
