/**
 * Release notes with one line per change, so that the release notes in the app (and on GitHub)
 * list the changes one below the other instead of in one long line.
 *
 * A pull request lists its changes in its description under `## Versionshinweise`, one per line.
 * The squash merge takes the description into the commit, and semantic-release (`release.config.mjs`)
 * makes each line an entry of its own. A line may start with its type (`fix: …`), otherwise it has
 * the type of the title. Releases from before name several changes in their title, separated by
 * `; `: they are split too, by the release notes generator and in the app.
 *
 * Only erasable TypeScript: `release.config.mjs` imports this file in Node directly.
 */

/** A change of a pull request for the release notes. */
export interface ReleaseLine {
  /** Conventional Commit type the line starts with, lower case (`fix`); null: the type of the title. */
  type: string | null
  text: string
}

const SECTION = /^#{1,6}\s*Versionshinweise\s*:?\s*$/i
const HEADING = /^#{1,6}\s/
const BULLET = /^[-*+]\s+/
const TYPED = /^(feat|fix|perf|revert|refactor|docs|style|test|build|ci|chore)(?:\([^)]*\))?!?:\s+(.+)$/
/** `; ` between changes, but not the one ending an HTML entity (`&amp; `). */
const SEPARATOR = /(?<!&#?\w+);\s+/

/**
 * The changes listed under `## Versionshinweise` in a commit's body (its pull request's description):
 * every bullet at the start of a line is one, a line wrapped below it belongs to it.
 */
export function releaseLines(body: string | null | undefined): ReleaseLine[] {
  if (!body) return []
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((line) => SECTION.test(line.trim()))
  if (start === -1) return []
  const found: ReleaseLine[] = []
  for (const raw of lines.slice(start + 1)) {
    const line = raw.replace(/<!--[\s\S]*?-->/g, '').trim()
    if (HEADING.test(line)) break
    if (!line) continue
    if (BULLET.test(raw)) {
      const text = line.replace(BULLET, '')
      const typed = TYPED.exec(text)
      found.push(typed ? { type: typed[1]!, text: typed[2]!.trim() } : { type: null, text })
    } else if (found.length > 0) {
      found[found.length - 1]!.text += ` ${line}`
    }
  }
  return found.filter((line) => line.text)
}

/** The description without its `## Versionshinweise`, which the release notes show already. */
export function withoutReleaseLines(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((line) => SECTION.test(line.trim()))
  if (start === -1) return body
  const end = lines.findIndex((line, i) => i > start && HEADING.test(line.trim()))
  return [...lines.slice(0, start), ...(end === -1 ? [] : lines.slice(end))].join('\n').trim()
}

/** Several changes in one line, separated by `; `. */
export function splitChanges(text: string): string[] {
  return text
    .split(SEPARATOR)
    .map((part, i) => (i === 0 ? part : capitalize(part)).trim())
    .filter(Boolean)
}

function capitalize(text: string): string {
  return text.replace(/^(\s*)(\p{Ll})/u, (_, space: string, letter: string) => `${space}${letter.toUpperCase()}`)
}

/** A type of the release notes, as in `presetConfig.types`. */
export interface NoteType {
  type: string
  section?: string
  hidden?: boolean
}

interface NoteCommit {
  subject?: string | null
  body?: string | null
}

interface NoteGroup<C> {
  title: string | false
  commits: C[]
}

interface NoteContext<C> {
  commitGroups?: NoteGroup<C>[]
  host?: string
  owner?: string
  repository?: string
}

/** The links to pull requests at the end of a subject, e.g. ` ([#66](…))`; they go with each line. */
const TRAILING_REFERENCES = /((?:\s*\((?:\[#\d+\]\([^)\s]+\)|#\d+)\))+)\s*$/

/**
 * `finalizeContext` of conventional-changelog-writer: each change a commit lists becomes an entry of
 * its own, in the section of its type, with the pull request's link. Lines of a hidden type
 * (`refactor: …`) stay out, as such commits do.
 */
export function splitReleaseNotes<C extends NoteCommit, T extends NoteContext<C>>(context: T, types: readonly NoteType[]): T {
  const groups = context.commitGroups
  if (!groups?.length) return context
  const sections = new Map<string, string | null>(types.map((t) => [t.type, t.hidden || !t.section ? null : t.section]))
  const order = [...new Set(types.flatMap((t) => (t.hidden || !t.section ? [] : [t.section])))]
  const split = new Map<string | false, C[]>()
  const add = (title: string | false, commit: C) => {
    const list = split.get(title)
    if (list) list.push(commit)
    else split.set(title, [commit])
  }

  for (const group of groups) {
    for (const commit of group.commits) {
      const subject = commit.subject ?? ''
      const match = TRAILING_REFERENCES.exec(subject)
      const references = match?.[1] ?? ''
      const text = match ? subject.slice(0, match.index) : subject
      const lines = releaseLines(commit.body)
      if (lines.length > 0) {
        for (const line of lines) {
          const section = line.type === null ? undefined : sections.get(line.type)
          if (section === null) continue
          add(section ?? group.title, { ...commit, subject: `${linkIssues(line.text, context)}${references}` })
        }
        continue
      }
      const parts = splitChanges(text)
      if (parts.length < 2) {
        add(group.title, commit)
        continue
      }
      for (const part of parts) add(group.title, { ...commit, subject: `${part}${references}` })
    }
  }

  const rank = (title: string | false) => {
    const index = title === false ? -1 : order.indexOf(title)
    return index === -1 ? order.length : index
  }
  const commitGroups = [...split].sort(([a], [b]) => rank(a) - rank(b)).map(([title, commits]) => ({ title, commits }))
  return { ...context, commitGroups }
}

/** `#12` in a line becomes a link, as the generator makes it in a title. */
function linkIssues(text: string, context: NoteContext<unknown>): string {
  const { host, owner, repository } = context
  if (!host || !owner || !repository) return text
  return text.replace(/(^|[\s(])#(\d+)\b/g, (_, before: string, id: string) => `${before}[#${id}](${host}/${owner}/${repository}/issues/${id})`)
}

/** A list item without lists in it, as GitHub renders the release notes. */
const LIST_ITEM = /<li>((?:(?!<\/?(?:li|ul|ol)\b)[\s\S])*)<\/li>/g
/** The links at its end: pull request and commit, e.g. ` (<a …>#66</a>) (<a …>c95f641</a>)`. */
const TRAILING_LINKS = /((?:\s*\(<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<\/a>\))+)\s*$/

/**
 * Splits the items of published release notes that name several changes, separated by `; `
 * (outside tags and code), into one item each, with the links of the item.
 */
export function splitNoteItems(html: string): string {
  return html.replace(LIST_ITEM, (item, inner: string) => {
    const links = TRAILING_LINKS.exec(inner)
    const content = links ? inner.slice(0, links.index) : inner
    const parts = splitOutsideTags(content)
    if (parts.length < 2) return item
    const tail = links?.[1] ?? ''
    return parts.map((part) => `<li>${part}${tail}</li>`).join('\n')
  })
}

function splitOutsideTags(html: string): string[] {
  const parts: string[] = []
  let current = ''
  let code = 0
  for (const token of html.split(/(<[^>]*>)/)) {
    if (token.startsWith('<')) {
      if (/^<(?:code|tt|pre)\b/i.test(token)) code++
      else if (/^<\/(?:code|tt|pre)>/i.test(token)) code = Math.max(0, code - 1)
      current += token
      continue
    }
    if (code > 0) {
      current += token
      continue
    }
    const pieces = token.split(SEPARATOR)
    current += pieces[0]
    for (const piece of pieces.slice(1)) {
      parts.push(current)
      current = capitalize(piece)
    }
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}
