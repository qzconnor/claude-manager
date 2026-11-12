import { describe, expect, it } from 'vitest'
import { fenceLanguages, loadFenceLanguages, useMarkdown } from './useMarkdown'

describe('useMarkdown', () => {
  it('keeps line breaks as typed only with breaks, and never lets HTML through', () => {
    expect(useMarkdown().render('eins\nzwei')).toBe('<p>eins\nzwei</p>\n')
    expect(useMarkdown(true).render('eins\nzwei')).toBe('<p>eins<br>\nzwei</p>\n')
    expect(useMarkdown(true).render('<img src=x onerror=alert(1)>')).not.toContain('<img')
  })

  it('finds the languages of code blocks, by their usual names too', () => {
    const source = 'Text\n```ts\nconst a = 1\n```\n\n~~~ sh title="x"\nls\n~~~\n```\nplain\n```\n```ts\nmore\n```\n    ```py (indented: code, no block)'
    expect(fenceLanguages(source)).toEqual(['typescript', 'bash'])
  })

  it('highlights code blocks once their language is loaded, and escapes them before', async () => {
    const source = '```pwsh\nGet-ChildItem "<b>"\n```'
    const plain = useMarkdown().render(source)
    expect(plain).toContain('Get-ChildItem &quot;&lt;b&gt;&quot;')
    expect(await loadFenceLanguages(source)).toBe(true)
    expect(await loadFenceLanguages(source)).toBe(false)
    const highlighted = useMarkdown().render(source)
    expect(highlighted).toContain('<pre><code class="hljs language-powershell"><span class="hljs-built_in">Get-ChildItem</span>')
    expect(highlighted).not.toContain('<b>')
  })
})
