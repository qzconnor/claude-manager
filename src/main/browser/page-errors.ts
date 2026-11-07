import type { ConsoleEntry } from './action-context'

/**
 * Errors the page didn't catch (exceptions, rejected promises nobody handled), from the DevTools
 * protocol's `Runtime.exceptionThrown`: with file, line and the chain of calls, which the console's
 * own line lacks. The console reports the same error once more (console-message); the two become one
 * entry (see `mergeError`).
 */

/** Frames of the chain of calls that are kept, async parts included. */
const MAX_FRAMES = 12
/** How long the two reports of one error may lie apart. */
const SAME_ERROR_MS = 2000

interface CallFrame {
  functionName?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
}

interface StackTrace {
  description?: string
  callFrames?: CallFrame[]
  parent?: StackTrace
}

interface ExceptionDetails {
  text?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
  stackTrace?: StackTrace
  exception?: { description?: string; value?: unknown; className?: string }
}

/** One frame as `at fn (url:line:column)`, lines and columns counted from 1. */
function frameLine(frame: CallFrame): string {
  const where = `${frame.url || '<anonymous>'}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1}`
  return frame.functionName ? `at ${frame.functionName} (${where})` : `at ${where}`
}

/** The chain of calls of an error, async parts marked; empty without one. */
export function stackLines(trace: StackTrace | undefined): string[] {
  const lines: string[] = []
  let part: StackTrace | undefined = trace
  let first = true
  while (part && lines.length < MAX_FRAMES) {
    if (!first && part.callFrames?.length) lines.push(`--- ${part.description || 'async'} ---`)
    for (const frame of part.callFrames ?? []) {
      if (lines.length >= MAX_FRAMES) break
      lines.push(frameLine(frame))
    }
    first = false
    part = part.parent
  }
  return lines
}

/** The message of an error: its first line as the console would print it, e.g. "Uncaught TypeError: x is undefined". */
export function errorMessage(details: ExceptionDetails): string {
  const description = details.exception?.description ?? (details.exception?.value !== undefined ? String(details.exception.value) : '')
  const head = description.split('\n')[0]
  const prefix = details.text?.trim() || 'Uncaught'
  if (!head || prefix.includes(head)) return prefix
  return prefix === 'Uncaught' || prefix === 'Uncaught (in promise)' ? `${prefix} ${head}` : `${prefix}: ${head}`
}

/** An error of `Runtime.exceptionThrown` as a console entry; `frame`: it came from a frame of another site. */
export function exceptionEntry(params: Record<string, unknown>, frame: boolean): ConsoleEntry {
  const details = (params.exceptionDetails ?? {}) as ExceptionDetails
  let stack = stackLines(details.stackTrace)
  if (stack.length === 0) {
    // Without a trace of the protocol, the error's own (e.g. a rejection with an Error).
    stack = (details.exception?.description ?? '')
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('at '))
      .slice(0, MAX_FRAMES)
  }
  const top = details.stackTrace?.callFrames?.[0]
  const source = top?.url
    ? `${top.url}:${(top.lineNumber ?? 0) + 1}`
    : details.url
      ? `${details.url}:${(details.lineNumber ?? 0) + 1}`
      : ''
  return {
    at: new Date().toISOString(),
    level: 'error',
    text: `${errorMessage(details)}${frame ? ' (in a frame)' : ''}`.slice(0, 2000),
    source,
    stack: stack.length ? stack.join('\n') : null,
  }
}

/**
 * Whether two entries are the same error, reported by the protocol and by the console: same first
 * line, close in time. The console's text may lack "Uncaught" or carry more lines.
 */
export function sameError(a: ConsoleEntry, b: ConsoleEntry): boolean {
  if (a.level !== 'error' || b.level !== 'error') return false
  if (Math.abs(Date.parse(a.at) - Date.parse(b.at)) > SAME_ERROR_MS) return false
  const first = (entry: ConsoleEntry) =>
    entry.text
      .split('\n')[0]
      .replace(/ \(in a frame\)$/, '')
      .replace(/^Uncaught (\(in promise\) )?/, '')
      .trim()
  return first(a) === first(b)
}

/**
 * Adds an entry to the console's (newest last), as one with an earlier report of the same error:
 * the protocol's trace goes to the console's entry. Returns false when it was one already there.
 */
export function mergeError(entries: ConsoleEntry[], entry: ConsoleEntry): boolean {
  for (let i = entries.length - 1; i >= Math.max(0, entries.length - 10); i--) {
    const other = entries[i]
    if (!sameError(other, entry)) continue
    if (!other.stack && entry.stack) {
      other.stack = entry.stack
      if (entry.text.startsWith('Uncaught')) other.text = entry.text
      if (!other.source) other.source = entry.source
    }
    return false
  }
  entries.push(entry)
  return true
}

/** An entry for Claude: its line, where it came from, and its chain of calls indented below. */
export function formatConsoleEntry(entry: ConsoleEntry): string {
  const head = `[${entry.level}] ${entry.text}${entry.source ? ` (${entry.source})` : ''}`
  if (!entry.stack) return head
  return `${head}\n${entry.stack
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')}`
}
