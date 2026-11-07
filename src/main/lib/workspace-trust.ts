import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, normalize, resolve, sep } from 'node:path'
import { readConfig as readGlobalConfig, withConfigLock, writeConfig } from './claude-config'

/**
 * Claude Code's question "Do you trust this folder?", mirrored from 2.1.x:
 * - A folder's entry in `projects` of the global config is keyed by its normalized path, with `/`
 *   on Windows and spelled as Claude Code was started (also the drive letter's case). Inside a git
 *   repository the key is the repository's root, for a worktree the main checkout's.
 * - The folder is trusted when that entry has `hasTrustDialogAccepted`, or the folder itself or one
 *   of its parents has, up to the repository's root (outside of one up to the drive's root).
 * - Saying yes sets the flag on the entry. Only in the home folder Claude Code keeps it for the
 *   running session; set in the config, it counts there as well.
 */

/** A project entry as Claude Code creates it. */
const PROJECT_DEFAULTS = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
}

const isWindows = process.platform === 'win32'

type Projects = Record<string, { hasTrustDialogAccepted?: unknown } | undefined>

interface GlobalConfig {
  projects?: Projects
  [key: string]: unknown
}

/** Where a folder's trust is looked up and saved. */
export interface TrustTarget {
  /** The folder as Claude Code gets started in, spelled like an existing entry where there is one. */
  cwd: string
  /** The folder whose entry holds the trust: the repository's root, or `cwd` outside of one. */
  folder: string
  /** `folder` as a key of `projects`. */
  key: string
  trusted: boolean
}

/** A path as Claude Code writes it into `projects`. */
export function projectKey(path: string): string {
  const normalized = normalize(path)
  return isWindows ? normalized.replaceAll('\\', '/') : normalized
}

/**
 * Finds out whether Claude Code trusts `cwd` with the given config file. A folder that has an entry
 * spelled differently (`f:/…` next to `F:\…` on Windows) gets that spelling, so Claude Code uses the
 * entry instead of adding a second one.
 */
export async function trustTarget(configFile: string, cwd: string): Promise<TrustTarget> {
  const projects = (await readConfig(configFile))?.projects ?? {}
  const dir = cleanPath(cwd)
  let root = await findGitRoot(dir)
  let folder = root ? await canonicalGitRoot(root) : dir
  let key = projectKey(folder)

  const spelled = projects[key] ? undefined : findSpelling(projects, key)
  // Only a folder that `cwd` lies in can be spelled through it; a worktree's main checkout can't.
  if (spelled && (folder === dir || folder === root)) {
    const respelled = fromKey(spelled)
    const rest = dir.slice(folder.length)
    if (root) root = respelled
    folder = respelled
    key = spelled
    return { cwd: respelled + rest, folder, key, trusted: isTrusted(projects, key, respelled + rest, root) }
  }
  return { cwd: dir, folder, key, trusted: isTrusted(projects, key, dir, root) }
}

/**
 * Sets `hasTrustDialogAccepted` on the target's entry, created like Claude Code does when it is missing.
 * Runs under Claude Code's own lock and on the current content, so running sessions lose nothing.
 */
export async function trustFolder(configFile: string, target: TrustTarget): Promise<void> {
  await withConfigLock(configFile, async () => {
    const config = (await readConfig(configFile)) ?? {}
    const projects: Projects = { ...config.projects }
    const entry = projects[target.key]
    if (entry?.hasTrustDialogAccepted === true) return
    // An entry with `\` comes from older versions and is no longer read: it moves to the new key.
    const legacy = entry ? undefined : Object.keys(projects).find((k) => k.includes('\\') && sameKey(k, target.key))
    const base = entry ?? (legacy ? projects[legacy] : undefined) ?? PROJECT_DEFAULTS
    if (legacy) delete projects[legacy]
    projects[target.key] = { ...base, hasTrustDialogAccepted: true }
    await writeConfig(configFile, { ...config, projects })
  })
}

/** The home folder: Claude Code itself trusts it only for the running session. */
export function isHomeFolder(folder: string, home: string): boolean {
  return sameKey(projectKey(folder), projectKey(cleanPath(home)))
}

function isTrusted(projects: Projects, key: string, cwd: string, root: string | null): boolean {
  if (projects[key]?.hasTrustDialogAccepted) return true
  // The folder and its parents, but not above the repository's root.
  const stop = root ? projectKey(root) : null
  let current = projectKey(cwd)
  for (;;) {
    if (stop !== null && current !== stop && !current.startsWith(stop.endsWith('/') ? stop : `${stop}/`)) return false
    if (projects[current]?.hasTrustDialogAccepted) return true
    if (current === stop) return false
    const parent = projectKey(resolve(current, '..'))
    if (parent === current) return false
    current = parent
  }
}

/** Another key of the same folder in Claude Code's format: Windows paths ignore case. */
function findSpelling(projects: Projects, key: string): string | undefined {
  if (!isWindows) return undefined
  return Object.keys(projects).find((k) => !k.includes('\\') && projects[k] && sameKey(k, key))
}

function sameKey(a: string, b: string): boolean {
  const unify = (key: string) => key.replaceAll('\\', '/')
  return isWindows ? unify(a).toLowerCase() === unify(b).toLowerCase() : a === b
}

function fromKey(key: string): string {
  return isWindows ? key.replaceAll('/', '\\') : key
}

/** Normalized, without a trailing separator (except for a root): as the process sees its cwd. */
function cleanPath(path: string): string {
  const normalized = normalize(resolve(path))
  return normalized.length > 1 && normalized.endsWith(sep) && dirname(normalized) !== normalized
    ? normalized.slice(0, -1)
    : normalized
}

/** The nearest folder upwards with a `.git` folder or file. */
async function findGitRoot(dir: string): Promise<string | null> {
  for (let current = dir; ; ) {
    const entry = await lstat(join(current, '.git')).catch(() => null)
    if (entry && (entry.isDirectory() || entry.isFile())) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** For a worktree its main checkout, otherwise the root itself. */
async function canonicalGitRoot(root: string): Promise<string> {
  try {
    const pointer = (await readFile(join(root, '.git'), 'utf8')).trim()
    if (!pointer.startsWith('gitdir:')) return root
    const gitDir = resolve(root, pointer.slice('gitdir:'.length).trim())
    const commonDir = resolve(gitDir, (await readFile(join(gitDir, 'commondir'), 'utf8')).trim())
    if (resolve(dirname(gitDir)) !== join(commonDir, 'worktrees')) return root
    const back = resolve(gitDir, (await readFile(join(gitDir, 'gitdir'), 'utf8')).trim())
    if ((await realpath(back)) !== join(await realpath(root), '.git')) return root
    if (basename(commonDir) !== '.git') {
      // A bare repository: its folder, unless it is a checkout after all.
      return (await lstat(join(commonDir, '.git')).catch(() => null)) ? root : commonDir
    }
    return dirname(commonDir)
  } catch {
    // A `.git` folder, or a pointer that doesn't lead to a worktree.
    return root
  }
}

/** Null when the file is missing; an unreadable file throws, so it is never overwritten. */
function readConfig(file: string): Promise<GlobalConfig | null> {
  return readGlobalConfig(file) as Promise<GlobalConfig | null>
}
