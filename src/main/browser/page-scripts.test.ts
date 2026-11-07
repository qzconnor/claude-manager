import { describe, expect, it } from 'vitest'
import { pageCall } from './page-scripts'

describe('pageCall', () => {
  it('is JavaScript the page can run, for every helper and its arguments', () => {
    const calls: [string, ...unknown[]][] = [
      ['snapshot', 40_000, false],
      ['find', 'Save "it"', 'button', false, 20],
      ['inspect', 'e3', ['grid-template-areas']],
      ['audit', 8],
      ['locator', 'e5'],
      ['storage', 'local', 'set', 'key', 'line\nbreak', 0],
      ['hitAt', 10, 20],
    ]
    for (const [name, ...args] of calls) expect(() => new Function(pageCall(name, ...args))).not.toThrow()
  })
})
