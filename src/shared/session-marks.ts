/** A tag is a word or two in a small badge: at most this long. */
export const MAX_TAG_LENGTH = 30
/** Tags of one session; more don't fit beside its title. */
export const MAX_SESSION_TAGS = 10

/** On one line, without the `#` one may type before it, not longer than a badge takes; empty for nothing but spaces. */
export function cleanTag(tag: string): string {
  return tag
    .replace(/\s+/g, ' ')
    .replace(/^[\s#]+/, '')
    .slice(0, MAX_TAG_LENGTH)
    .trim()
}

/** The same tag, whatever its case. */
export function tagKey(tag: string): string {
  return tag.toLocaleLowerCase('de')
}

/** Cleaned and each once (the first spelling stays), at most `MAX_SESSION_TAGS`, in the order given. */
export function cleanTags(tags: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const clean: string[] = []
  for (const tag of tags) {
    const next = typeof tag === 'string' ? cleanTag(tag) : ''
    if (!next || seen.has(tagKey(next))) continue
    seen.add(tagKey(next))
    clean.push(next)
    if (clean.length === MAX_SESSION_TAGS) break
  }
  return clean
}

/** Whether the session has the tag, whatever its case. */
export function hasTag(tags: readonly string[], tag: string): boolean {
  const key = tagKey(tag)
  return tags.some((t) => tagKey(t) === key)
}

/** The tags of all these sessions, each once (the spelling met first), in alphabetical order. */
export function allTags(sessions: readonly { tags: readonly string[] }[]): string[] {
  const byKey = new Map<string, string>()
  for (const session of sessions) for (const tag of session.tags) if (!byKey.has(tagKey(tag))) byKey.set(tagKey(tag), tag)
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }))
}
