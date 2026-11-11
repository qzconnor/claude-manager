/** The longest name of a file or folder most file systems take (NTFS, ext4, APFS). */
export const MAX_NAME_LENGTH = 255

/** Characters Windows doesn't take in a name, and the control characters. */
const WINDOWS_FORBIDDEN = /[<>:"|?*\\\u0000-\u001f]/
/** Names Windows keeps for devices, also with an extension (`nul.txt`). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/**
 * Why `name` can't be the name of a file or folder on `platform`, in words for the user; null when it
 * can. `.git` is refused everywhere: a folder of that name is git's, not one to make or rename by hand.
 */
export function nameProblem(name: string, platform: string): string | null {
  if (name.trim() === '') return 'Gib einen Namen ein.'
  if (name === '.' || name === '..') return '„.“ und „..“ sind keine Namen.'
  if (name.includes('/') || name.includes('\0')) return 'Ein Name darf kein „/“ enthalten.'
  if (name.length > MAX_NAME_LENGTH) return `Der Name ist zu lang (höchstens ${MAX_NAME_LENGTH} Zeichen).`
  if (name.toLowerCase() === '.git') return '„.git“ gehört Git.'
  if (platform === 'win32') {
    if (WINDOWS_FORBIDDEN.test(name)) return 'Windows erlaubt diese Zeichen in Namen nicht: \\ : * ? " < > |'
    if (/[. ]$/.test(name)) return 'Unter Windows darf ein Name nicht auf Punkt oder Leerzeichen enden.'
    if (WINDOWS_DEVICE.test(name)) return `„${name.split('.')[0]}“ ist unter Windows ein Gerätename.`
  }
  return null
}

/**
 * Why the relative path `path` (`/`-separated, like the tree's) can't be made: each of its parts is
 * checked as a name. Null when it can.
 */
export function pathProblem(path: string, platform: string): string | null {
  if (path.trim() === '') return nameProblem(path, platform)
  for (const part of path.split('/')) {
    if (part === '') return 'Der Pfad hat einen leeren Teil („//“ oder „/“ am Anfang oder Ende).'
    const problem = nameProblem(part, platform)
    if (problem) return problem
  }
  return null
}
