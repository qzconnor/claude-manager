import MarkdownIt from 'markdown-it'

function createRenderer() {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false })
  const defaultLinkOpen =
    md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noopener noreferrer')
    return defaultLinkOpen(tokens, idx, options, env, self)
  }
  return md
}

let instance: ReturnType<typeof createRenderer> | null = null

/** Shared markdown renderer. Raw HTML is disabled, so the output is safe for v-html. */
export function useMarkdown() {
  const md = (instance ??= createRenderer())
  return { render: (source: string) => md.render(source) }
}

/** Opens markdown links in the system browser instead of navigating the app window. */
export function handleMarkdownClick(event: MouseEvent): void {
  const anchor = (event.target as HTMLElement | null)?.closest('a')
  if (!anchor) return
  event.preventDefault()
  const href = anchor.getAttribute('href') ?? ''
  if (/^https?:\/\//i.test(href)) void window.api.app.openExternal(href)
}
