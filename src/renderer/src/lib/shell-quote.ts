import type { TerminalMode } from '@shared/types'
import { formatArgs } from './args'

/** The shells `shell` terminals start: PowerShell on Windows, the user's login shell (bash, zsh, fish …) elsewhere. */
export type ShellKind = 'powershell' | 'posix'

/**
 * Characters that are just themselves in every shell, in a word of their own (the first one starts no
 * option, splatting or `=command`). Everything else (`$`, a backtick, `;`, `&`, `(`, a space, a comma that
 * PowerShell reads as an array …) gets quotes, so a dropped file can't run anything when Enter follows.
 */
const PLAIN = /^[\p{L}\p{N}_./\\][\p{L}\p{N}_.:/\\@%+=-]*$/u

/** Control characters: a file under Linux may have them in its name, ESC [201~ would end a bracketed paste. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g

/** PowerShell ends a single-quoted string at any of these, not only at the ASCII one. */
const POWERSHELL_QUOTES = /['‘’‚‛]/g

/** What a POSIX shell gets outside the quotes: a quote or backslash escaped, a control character as `?`. */
// eslint-disable-next-line no-control-regex
const POSIX_SPECIAL = /['\\\x00-\x1f\x7f-\x9f]/g

/**
 * The path as one word the shell reads literally: in single quotes, where neither PowerShell nor a POSIX
 * shell expands `$(…)`, backticks or variables. Double quotes, as Windows Terminal uses, are not enough:
 * both expand `$(…)` in them.
 */
export function quotePath(path: string, shell: ShellKind): string {
  if (PLAIN.test(path) && (shell === 'powershell' || !path.includes('\\'))) return path
  if (shell === 'powershell') {
    // PowerShell takes a quote doubled as itself; Windows allows no control characters in names.
    return `'${path.replace(POWERSHELL_QUOTES, (quote) => quote + quote).replace(CONTROL, '?')}'`
  }
  // A quote or backslash stands escaped between two quoted runs: fish reads \' and \\ as escapes inside
  // single quotes, bash doesn't, outside both agree. A control character becomes `?` outside the quotes,
  // which as a glob finds the file again.
  const quoted = path.replace(POSIX_SPECIAL, (char) => (char === "'" || char === '\\' ? `'\\${char}'` : `'?'`))
  return `'${quoted}'`
}

/**
 * Paths for the input of a terminal, separated by spaces: a shell gets them quoted so it runs nothing in
 * them, Claude Code (a session or login) like in Windows Terminal, in double quotes when they hold spaces,
 * which it also understands for images.
 */
export function pastedPaths(paths: readonly string[], mode: TerminalMode, shell: ShellKind): string {
  if (mode === 'shell') return paths.map((path) => quotePath(path, shell)).join(' ')
  return formatArgs(paths.map((path) => path.replace(CONTROL, '?')))
}
