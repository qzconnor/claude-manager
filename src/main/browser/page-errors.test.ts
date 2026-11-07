import { describe, expect, it } from 'vitest'
import type { ConsoleEntry } from './action-context'
import { errorMessage, exceptionEntry, formatConsoleEntry, mergeError, sameError, stackLines } from './page-errors'

const thrown = {
  exceptionDetails: {
    text: 'Uncaught',
    url: 'http://localhost:5173/src/app.js',
    lineNumber: 41,
    stackTrace: {
      callFrames: [
        { functionName: 'save', url: 'http://localhost:5173/src/app.js', lineNumber: 41, columnNumber: 8 },
        { functionName: '', url: 'http://localhost:5173/src/main.js', lineNumber: 2, columnNumber: 0 },
      ],
      parent: { description: 'Promise.then', callFrames: [{ functionName: 'load', url: 'http://localhost:5173/src/main.js', lineNumber: 9, columnNumber: 4 }] },
    },
    exception: { description: "TypeError: Cannot read properties of undefined (reading 'id')\n    at save (http://localhost:5173/src/app.js:42:9)" },
  },
}

function entry(change: Partial<ConsoleEntry>): ConsoleEntry {
  return { at: '2026-11-07T10:00:00.000Z', level: 'error', text: 'Uncaught Error: boom', source: '', stack: null, ...change }
}

describe('stackLines', () => {
  it('lists the frames counted from 1, async parts marked', () => {
    expect(stackLines(thrown.exceptionDetails.stackTrace)).toEqual([
      'at save (http://localhost:5173/src/app.js:42:9)',
      'at http://localhost:5173/src/main.js:3:1',
      '--- Promise.then ---',
      'at load (http://localhost:5173/src/main.js:10:5)',
    ])
    expect(stackLines(undefined)).toEqual([])
  })
})

describe('errorMessage', () => {
  it('reads like the console', () => {
    expect(errorMessage(thrown.exceptionDetails)).toBe("Uncaught TypeError: Cannot read properties of undefined (reading 'id')")
    expect(errorMessage({ text: 'Uncaught (in promise)', exception: { value: 'nope' } })).toBe('Uncaught (in promise) nope')
    expect(errorMessage({ text: 'Uncaught Error: boom', exception: { description: 'Error: boom\n    at x' } })).toBe('Uncaught Error: boom')
    expect(errorMessage({ text: 'Uncaught' })).toBe('Uncaught')
  })
})

describe('exceptionEntry', () => {
  it('makes an error entry with where it happened and its stack', () => {
    const made = exceptionEntry(thrown, false)
    expect(made.level).toBe('error')
    expect(made.text).toBe("Uncaught TypeError: Cannot read properties of undefined (reading 'id')")
    expect(made.source).toBe('http://localhost:5173/src/app.js:42')
    expect(made.stack?.split('\n')).toHaveLength(4)
    expect(exceptionEntry(thrown, true).text).toMatch(/\(in a frame\)$/)
  })

  it('takes the stack from the error itself without a trace of the protocol', () => {
    const made = exceptionEntry({ exceptionDetails: { text: 'Uncaught (in promise)', exception: { description: 'Error: late\n    at later (http://x/a.js:5:3)\n    at async run (http://x/a.js:9:1)' } } }, false)
    expect(made.stack).toBe('at later (http://x/a.js:5:3)\nat async run (http://x/a.js:9:1)')
  })
})

describe('mergeError', () => {
  it('gives the console’s report of an error the stack the protocol reports', () => {
    const entries = [entry({ text: 'Uncaught Error: boom', source: 'http://x/a.js:3' })]
    expect(mergeError(entries, entry({ stack: 'at f (http://x/a.js:3:1)' }))).toBe(false)
    expect(entries).toHaveLength(1)
    expect(entries[0].stack).toBe('at f (http://x/a.js:3:1)')
  })

  it('leaves out the console’s report after the protocol’s', () => {
    const entries = [entry({ stack: 'at f (x:1:1)' })]
    expect(mergeError(entries, entry({ text: 'Error: boom', at: '2026-11-07T10:00:00.500Z' }))).toBe(false)
    expect(entries).toHaveLength(1)
  })

  it('keeps errors apart that are different or far apart in time, and other messages', () => {
    const entries = [entry({})]
    expect(mergeError(entries, entry({ text: 'Uncaught Error: other' }))).toBe(true)
    expect(mergeError(entries, entry({ at: '2026-11-07T10:00:09.000Z' }))).toBe(true)
    expect(mergeError(entries, entry({ level: 'log', text: 'Uncaught Error: boom' }))).toBe(true)
    expect(entries).toHaveLength(4)
    expect(sameError(entry({ text: 'Uncaught (in promise) Error: x' }), entry({ text: 'Error: x (in a frame)' }))).toBe(true)
  })
})

describe('formatConsoleEntry', () => {
  it('puts the stack indented below the line', () => {
    expect(formatConsoleEntry(entry({ source: 'http://x/a.js:3', stack: 'at f (x:1:1)\nat g (x:2:1)' }))).toBe(
      '[error] Uncaught Error: boom (http://x/a.js:3)\n    at f (x:1:1)\n    at g (x:2:1)',
    )
    expect(formatConsoleEntry(entry({ level: 'log', text: 'hi' }))).toBe('[log] hi')
  })
})
