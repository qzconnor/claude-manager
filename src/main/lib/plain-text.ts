/** Markdown of an answer as plain text on one line; code blocks are left out. */
export function plainText(markdown: string | null): string | null {
  if (!markdown) return null
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/^[ \t]{0,3}(#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]?)/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return text || null
}

/** Text on one line, cut to `max` characters with an ellipsis; null without text. */
export function oneLine(text: string | null | undefined, max: number): string | null {
  const single = text?.replace(/\s+/g, ' ').trim()
  if (!single) return null
  return single.length > max ? `${single.slice(0, max - 1)}…` : single
}
