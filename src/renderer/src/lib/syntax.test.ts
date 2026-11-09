import { describe, expect, it } from 'vitest'
import { fileLines, parsePatch } from './file-diff'
import { highlightDiff, languageOf, loadLanguage, splitHighlighted } from './syntax'

describe('languageOf', () => {
  it('knows files by extension and by name', () => {
    expect(languageOf('src/App.vue')).toBe('vue')
    expect(languageOf('src/routes/+page.svelte')).toBe('vue')
    expect(languageOf('CMakeLists.txt')).toBe('cmake')
    expect(languageOf('app/build.gradle')).toBe('gradle')
    expect(languageOf('scripts/run.bat')).toBe('dos')
    expect(languageOf('api/schema.graphql')).toBe('graphql')
    expect(languageOf('Jenkinsfile')).toBe('groovy')
    expect(languageOf('src/a.test.TS')).toBe('typescript')
    expect(languageOf('Dockerfile')).toBe('dockerfile')
    expect(languageOf('deploy/api.dockerfile')).toBe('dockerfile')
    expect(languageOf('.env.local')).toBe('ini')
    expect(languageOf('LICENSE')).toBeNull()
    expect(languageOf('notes.unknown')).toBeNull()
  })
})

describe('splitHighlighted', () => {
  it('closes spans at a line end and opens them again on the next line', () => {
    const html = 'a<span class="c">/* one\ntwo */</span> b\n<span class="k">x</span>'
    expect(splitHighlighted(html)).toEqual([
      'a<span class="c">/* one</span>',
      '<span class="c">two */</span> b',
      '<span class="k">x</span>',
    ])
  })

  it('keeps nested spans and empty lines', () => {
    expect(splitHighlighted('<span class="a"><span class="b">x\n\ny</span></span>')).toEqual([
      '<span class="a"><span class="b">x</span></span>',
      '<span class="a"><span class="b"></span></span>',
      '<span class="a"><span class="b">y</span></span>',
    ])
  })
})

describe('highlightDiff', () => {
  it('highlights the old and the new side, each line on its own', async () => {
    expect(await loadLanguage('typescript')).toBe(true)
    const { lines } = parsePatch(['@@ -1,2 +1,2 @@', ' const a = 1', "-const b = '<old>'", "+const b = '<new>'"].join('\n'))
    const html = highlightDiff(lines, 'typescript')!
    expect(html[0]).toBeNull()
    expect(html[1]).toContain('hljs-keyword')
    // Escaped by highlight.js, so it can go into the page as HTML.
    expect(html[2]).toContain('&lt;old&gt;')
    expect(html[3]).toContain('&lt;new&gt;')
    expect(html[2]).toContain('hljs-string')
  })

  it('leaves out languages that are not loaded', () => {
    expect(highlightDiff(parsePatch('@@ -1 +1 @@\n-a\n+b').lines, 'cobol')).toBeNull()
  })
})

describe('languages', () => {
  it('loads every language a file can have', async () => {
    const names = [
      'apache', 'bash', 'c', 'clojure', 'cmake', 'cpp', 'csharp', 'css', 'dart', 'diff', 'django', 'dockerfile', 'dos',
      'elixir', 'erlang', 'fsharp', 'go', 'gradle', 'graphql', 'groovy', 'handlebars', 'haskell', 'ini', 'java',
      'javascript', 'json', 'julia', 'kotlin', 'latex', 'less', 'lua', 'makefile', 'markdown', 'nginx', 'nix',
      'objectivec', 'ocaml', 'perl', 'php', 'powershell', 'properties', 'protobuf', 'python', 'r', 'ruby', 'rust',
      'scala', 'scss', 'sql', 'stylus', 'swift', 'twig', 'typescript', 'vbnet', 'vim', 'vue', 'x86asm', 'xml', 'yaml',
    ]
    const loaded = await Promise.all(names.map(async (name) => [name, await loadLanguage(name)] as const))
    expect(loaded.filter(([, ok]) => !ok).map(([name]) => name)).toEqual([])
  })
})

describe('Vue', () => {
  const file = [
    '<script setup lang="ts">',
    'const count: number = 1',
    '</script>',
    '',
    '<template>',
    '  <div :class="box">{{ count + 1 }}</div>',
    '</template>',
    '',
    '<style scoped>',
    '.box { color: red; }',
    '</style>',
  ]

  it('highlights the script, the markup and the style each in its language', async () => {
    expect(await loadLanguage('vue')).toBe(true)
    const html = highlightDiff(fileLines(file.join('\n'), 'add').lines, 'vue')!
    expect(html[0]).toContain('hljs-name')
    expect(html[1]).toContain('<span class="hljs-keyword">const</span>')
    expect(html[1]).toContain('hljs-built_in')
    expect(html[5]).toContain('<span class="hljs-name">div</span>')
    expect(html[5]).toContain('hljs-number')
    expect(html[9]).toContain('hljs-selector-class')
  })

  it('highlights a changed line of the script in its file', async () => {
    expect(await loadLanguage('vue')).toBe(true)
    const { lines } = parsePatch(['@@ -2 +2 @@', '-const count: number = 0', '+const count: number = 1'].join('\n'))
    const whole = parsePatch(
      [
        '@@ -1,11 +1,11 @@',
        ` ${file[0]}`,
        '-const count: number = 0',
        '+const count: number = 1',
        ...file.slice(2).map((line) => ` ${line}`),
      ].join('\n'),
    ).lines
    // On its own the hunk has no <script> around it: just text of the markup.
    expect(highlightDiff(lines, 'vue')![2]).not.toContain('hljs-keyword')
    const html = highlightDiff(lines, 'vue', whole)!
    expect(html[0]).toBeNull()
    expect(html[1]).toContain('<span class="hljs-keyword">const</span>')
    expect(html[2]).toContain('<span class="hljs-keyword">const</span>')
  })

  it('highlights the hunks alone when the whole file is of another moment', async () => {
    expect(await loadLanguage('typescript')).toBe(true)
    const { lines } = parsePatch(['@@ -1 +1 @@', '-let a = 1', '+let a = 2'].join('\n'))
    const other = parsePatch(['@@ -1 +1 @@', '-let b = 1', '+let b = 2'].join('\n')).lines
    expect(highlightDiff(lines, 'typescript', other)).toEqual(highlightDiff(lines, 'typescript'))
  })
})

