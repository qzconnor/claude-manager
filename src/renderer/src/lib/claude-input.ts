/**
 * Claude Code's input box as the terminal shows it: the line with the cursor, `❯ ` and the text typed,
 * between two rules (`───`). Below it, while a slash command is typed, the list of commands with the one
 * Enter runs marked `❯` (also for a part of its name: `/dif` runs a marked `/diff`). Read off the
 * screen, since Claude Code tells nobody what is typed.
 */
export interface ClaudeInput {
  /** The text typed. */
  text: string
  /** The slash command Enter runs: the one marked in the list, else the one typed; null for a message. */
  command: string | null
}

/** After `❯` Claude Code puts a no-break space (U+00A0), which `\s` takes too. */
const PROMPT_RE = /^❯\s(.*)$/
const RULE_RE = /^─{3,}/
const MARKED_RE = /^\s+❯\s(\/\S+)/
/** Lines below the box searched for the marked command. */
const LIST_LINES = 12

/**
 * The input box on the screen (`lines`, one string per line) whose text line is `row`, the line of the
 * cursor; null when the cursor isn't in a box of one line (a message of several lines, a dialog).
 */
export function claudeInputAt(lines: readonly string[], row: number): ClaudeInput | null {
  const match = PROMPT_RE.exec(lines[row] ?? '')
  if (!match || !RULE_RE.test(lines[row - 1] ?? '') || !RULE_RE.test(lines[row + 1] ?? '')) return null
  const text = match[1]!.trim()
  if (!text.startsWith('/')) return { text, command: null }
  for (const line of lines.slice(row + 2, row + 2 + LIST_LINES)) {
    const marked = MARKED_RE.exec(line)
    if (marked) return { text, command: marked[1]! }
  }
  return { text, command: text.split(/\s/, 1)[0]! }
}
