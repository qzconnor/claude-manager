/**
 * Names for `claude --worktree <name>`: the worktree lands in `.claude/worktrees/<name>` on the
 * branch `worktree-<name>`, so the name has to suit a folder and a git branch alike.
 */

const MAX_LENGTH = 64

/** Why the name doesn't work; null when it does. An empty name is fine: Claude Code picks one. */
export function worktreeNameError(raw: string): string | null {
  const name = raw.trim()
  if (!name) return null
  if (name.length > MAX_LENGTH) return `Höchstens ${MAX_LENGTH} Zeichen.`
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'Nur Buchstaben ohne Umlaute, Ziffern, Punkt, Binde- und Unterstrich.'
  if (!/^[A-Za-z0-9]/.test(name)) return 'Der Name beginnt mit einem Buchstaben oder einer Ziffer.'
  if (name.includes('..') || name.endsWith('.') || name.toLowerCase().endsWith('.lock')) {
    return 'Git erlaubt keine zwei Punkte hintereinander und kein „.“ oder „.lock“ am Ende.'
  }
  return null
}

/** The arguments for Claude Code; without a name it makes one up. */
export function worktreeArgs(raw: string): string[] {
  const name = raw.trim()
  return name ? ['--worktree', name] : ['--worktree']
}
