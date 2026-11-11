import { nameProblem, pathProblem } from '@shared/file-names'

/** What the name dialog of the file tree does: make a file or a folder, or rename an entry. */
export type NameKind = 'file' | 'folder' | 'rename'

/** What the name dialog of the file tree is opened for. */
export interface NameRequest {
  kind: NameKind
  /** The folder the entry is (or comes) in, relative to the tree; '' is the tree's own. */
  parent: string
  /** The entry's name as it is (`rename`); empty for a new one. */
  name: string
  /** `rename`: the entry is a folder. */
  dir: boolean
}

/** The tree's path of an entry `name` in the folder `parent`. */
export function childPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

/**
 * The path in the tree that the name typed in the dialog gives, with what is wrong with it (null when
 * nothing). Spaces around the name are dropped. A new entry may name folders on its way (`lib/new.ts`),
 * on Windows also with `\`; a new name for an entry is one name.
 */
export function typedPath(request: NameRequest, typed: string, platform: string): { path: string; problem: string | null } {
  let name = typed.trim()
  if (request.kind !== 'rename' && platform === 'win32') name = name.replaceAll('\\', '/')
  const problem = request.kind === 'rename' ? nameProblem(name, platform) : pathProblem(name, platform)
  return { path: childPath(request.parent, name), problem }
}

/** Where to end the selection in a name to rename: before a file's extension; the whole for a folder or `.env`. */
export function stemEnd(name: string, dir: boolean): number {
  const dot = name.lastIndexOf('.')
  return dir || dot <= 0 ? name.length : dot
}
