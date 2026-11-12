import MarkdownIt from 'markdown-it'
import { fenceLanguage, hasLanguage, highlightCode, loadLanguage } from '@/lib/syntax'

function createRenderer(breaks: boolean) {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks,
    typographer: false,
    // Code blocks in a loaded language come highlighted (escaped by highlight.js), the others plain.
    highlight: (code, info) => {
      const language = fenceLanguage(info)
      const html = language ? highlightCode(code, language) : null
      return html ? `<pre><code class="hljs language-${language}">${html}</code></pre>` : ''
    },
  })
  const defaultLinkOpen =
    md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noopener noreferrer')
    return defaultLinkOpen(tokens, idx, options, env, self)
  }
  return md
}

const instances = new Map<boolean, ReturnType<typeof createRenderer>>()

/**
 * Shared markdown renderer. Raw HTML is disabled, so the output is safe for v-html. `breaks`: every
 * line break counts, as in what a user typed; Claude's answers are markdown where it doesn't.
 */
export function useMarkdown(breaks = false) {
  let md = instances.get(breaks)
  if (!md) instances.set(breaks, (md = createRenderer(breaks)))
  return { render: (source: string) => md.render(source) }
}

/** The languages of the code blocks in a markdown text, as highlight.js names them. */
export function fenceLanguages(source: string): string[] {
  const found = new Set<string>()
  for (const match of source.matchAll(/^ {0,3}(?:`{3,}|~{3,})[ \t]*([^\s`]+)/gm)) {
    const language = fenceLanguage(match[1]!)
    if (language) found.add(language)
  }
  return [...found]
}

/**
 * Loads the languages of a text's code blocks that aren't loaded yet; true when one was, so the text is
 * rendered again with them highlighted.
 */
export async function loadFenceLanguages(source: string): Promise<boolean> {
  const missing = fenceLanguages(source).filter((language) => !hasLanguage(language))
  if (missing.length === 0) return false
  const loaded = await Promise.all(missing.map(loadLanguage))
  return loaded.some(Boolean)
}

/** Opens markdown links in the system browser instead of navigating the app window. */
export function handleMarkdownClick(event: MouseEvent): void {
  const anchor = (event.target as HTMLElement | null)?.closest('a')
  if (!anchor) return
  event.preventDefault()
  const href = anchor.getAttribute('href') ?? ''
  if (/^https?:\/\//i.test(href)) void window.api.app.openExternal(href)
}
