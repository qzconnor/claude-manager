import { folderKey, inFolder } from './folders'

/**
 * A workspace is a folder whose subfolders are its projects. Its file of this name holds what every
 * session in it gets appended to Claude Code's system prompt.
 */
export const WORKSPACE_PROMPT_FILE = 'cm_prompts.md'

const MAX_NAME_LENGTH = 120
/** Characters Windows doesn't allow in a file name, and control characters. */
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/
/** Names Windows keeps for devices, also with an extension (`con.txt`). */
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/** Why `raw` doesn't work as the name of a new workspace folder (or of a project in one); null when it does. */
export function workspaceNameError(raw: string, what: 'Workspace' | 'Projekt' = 'Workspace'): string | null {
  const name = raw.trim()
  if (!name) return `Gib dem ${what} einen Namen.`
  if (name.length > MAX_NAME_LENGTH) return `Höchstens ${MAX_NAME_LENGTH} Zeichen.`
  if (INVALID_CHARS.test(name)) return 'Ohne \\ / : * ? " < > |, der Name wird ein Ordner.'
  if (name === '.' || name === '..' || name.endsWith('.')) return 'Der Name endet nicht mit einem Punkt.'
  if (RESERVED_NAME.test(name)) return `„${name}“ ist unter Windows für Geräte reserviert.`
  return null
}

/** The parts of a path, without empty ones: `C:\a\b` → `C:`, `a`, `b`; `/home/me` → `home`, `me`. */
export function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}

/** The workspaces of `folders` that `path` lies in (or is), the outermost first. */
export function workspacesContaining(path: string, folders: readonly string[]): string[] {
  return folders
    .filter((folder) => inFolder(path, folder))
    .sort((a, b) => pathSegments(folderKey(a)).length - pathSegments(folderKey(b)).length)
}

/** The workspace `path` belongs to: the innermost one it lies in; null outside all of them. */
export function workspaceOf(path: string, folders: readonly string[]): string | null {
  return workspacesContaining(path, folders).at(-1) ?? null
}
