/** `claude-opus-5-5` → `Opus 5.5`, `claude-haiku-4-5-20251001` → `Haiku 4.5`; null for anything else. */
export function modelName(id: string | null): string | null {
  const match = id ? /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i.exec(id) : null
  if (!match) return null
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase()
  return `${family} ${match[3] ? `${match[2]}.${match[3]}` : match[2]}`
}
