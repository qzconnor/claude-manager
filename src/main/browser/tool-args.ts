import { isAbsolute, resolve } from 'node:path'

/**
 * What the tools of the app's MCP server (the browser's and the app's) share: their error for
 * Claude and the checks of the arguments Claude passes.
 */

export type Args = Record<string, unknown>

/** A tool's error for Claude: it ends up in the result, not as a failure of the protocol. */
export class ToolError extends Error {}

export function requiredString(args: Args, key: string, max: number, allowEmpty = false): string {
  const value = args[key]
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) throw new ToolError(`${key} must be a non-empty string.`)
  if (value.length > max) throw new ToolError(`${key} is too long.`)
  return value
}

export function optionalString(args: Args, key: string, max: number): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ToolError(`${key} must be a string.`)
  if (value.length > max) throw new ToolError(`${key} is too long.`)
  return value
}

export function optionalPath(args: Args, key: string): string | undefined {
  const value = optionalString(args, key, 1000)?.trim()
  if (!value) return undefined
  if (!isAbsolute(value)) throw new ToolError(`${key} must be an absolute path.`)
  return resolve(value)
}

export function optionalBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new ToolError(`${key} must be true or false.`)
  return value
}

export function optionalNumber(args: Args, key: string, min: number, max: number): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ToolError(`${key} must be a number from ${min} to ${max}.`)
  }
  return value
}

export function oneOf<T extends string>(args: Args, key: string, values: readonly T[], fallback?: T): T {
  const value = args[key]
  if ((value === undefined || value === null) && fallback !== undefined) return fallback
  if (typeof value !== 'string' || !values.includes(value as T)) throw new ToolError(`${key} must be one of ${values.join(', ')}.`)
  return value as T
}

export function stringList(args: Args, key: string, maxItems: number): string[] {
  const value = args[key]
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) {
    throw new ToolError(`${key} must be a non-empty list of strings.`)
  }
  if (value.length > maxItems) throw new ToolError(`${key} takes at most ${maxItems} entries.`)
  return value as string[]
}

/** Text for a result, cut to `max` characters. */
export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
