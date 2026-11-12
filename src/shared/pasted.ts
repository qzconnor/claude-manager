/**
 * Text pasted into Claude Code, as it writes it into a prompt: `<pasted_content id="63cd">` before and
 * `</pasted_content id="63cd">` after (older versions close without the id).
 */
const PASTED = /<pasted_content id="([^"]*)">\r?\n?([\s\S]*?)\r?\n?<\/pasted_content(?: id="[^"]*")?>/g

export type PromptPart = { kind: 'text'; text: string } | { kind: 'pasted'; id: string; text: string }

/** A prompt in what was typed and what was pasted, in order; text parts that are only blank are left out. */
export function promptParts(prompt: string): PromptPart[] {
  const parts: PromptPart[] = []
  let last = 0
  const typed = (text: string) => {
    if (text.trim()) parts.push({ kind: 'text', text: text.trim() })
  }
  for (const match of prompt.matchAll(PASTED)) {
    typed(prompt.slice(last, match.index))
    parts.push({ kind: 'pasted', id: match[1], text: match[2] })
    last = match.index + match[0].length
  }
  typed(prompt.slice(last))
  return parts
}

/** The prompt with pasted text as plain text, for titles and the search. */
export function unwrapPasted(prompt: string): string {
  return prompt.replace(PASTED, (_match, _id: string, text: string) => text)
}
