import hljs from 'highlight.js/lib/core'
import type { LanguageFn } from 'highlight.js'
import type { DiffLine } from './file-diff'

/**
 * Syntax highlighting for the file diff, with highlight.js: a language is loaded the first time a
 * file of it is shown. The colours come from the terminal's theme (`.syntax` in main.css).
 */

const LOADERS: Record<string, () => Promise<{ default: LanguageFn }>> = {
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  dart: () => import('highlight.js/lib/languages/dart'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  go: () => import('highlight.js/lib/languages/go'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  less: () => import('highlight.js/lib/languages/less'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  php: () => import('highlight.js/lib/languages/php'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  python: () => import('highlight.js/lib/languages/python'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scss: () => import('highlight.js/lib/languages/scss'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
}

/** Languages embedded in another one: HTML and Vue files have scripts and styles. */
const EMBEDDED: Record<string, string[]> = {
  xml: ['javascript', 'typescript', 'css'],
  markdown: ['bash', 'javascript', 'typescript', 'json'],
}

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  webmanifest: 'json',
  html: 'xml',
  htm: 'xml',
  xhtml: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  xaml: 'xml',
  csproj: 'xml',
  plist: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  py: 'python',
  pyw: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  sql: 'sql',
  ini: 'ini',
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  lua: 'lua',
  dart: 'dart',
  diff: 'diff',
  patch: 'diff',
}

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.gitconfig': 'ini',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
}

/** The language of a file by its name (`/`-separated path); null for one without highlighting. */
export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]
  if (name.startsWith('dockerfile') || name.endsWith('.dockerfile')) return 'dockerfile'
  if (name === '.env' || name.startsWith('.env.')) return 'ini'
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? (BY_EXTENSION[name.slice(dot + 1)] ?? null) : null
}

const loading = new Map<string, Promise<boolean>>()

function loadOne(name: string): Promise<boolean> {
  let promise = loading.get(name)
  if (!promise) {
    const load = LOADERS[name]
    promise = load
      ? load()
          .then((module) => {
            hljs.registerLanguage(name, module.default)
            return true
          })
          .catch(() => false)
      : Promise.resolve(false)
    loading.set(name, promise)
  }
  return promise
}

/** Loads a language (and those embedded in it); false if there is none of that name. */
export async function loadLanguage(name: string): Promise<boolean> {
  await Promise.all((EMBEDDED[name] ?? []).map(loadOne))
  return loadOne(name)
}

/** The language is loaded, so it highlights at once. */
export const hasLanguage = (name: string) => hljs.getLanguage(name) !== undefined

/** More text than this isn't highlighted: it would hold up the window. */
const MAX_HIGHLIGHT_CHARS = 400_000

/**
 * highlight.js' HTML split into lines; a span open across a line end is closed at its end and opened
 * again on the next line, so every line stands alone.
 */
export function splitHighlighted(html: string): string[] {
  const lines: string[] = []
  const open: string[] = []
  const tokens = /<span[^>]*>|<\/span>|\n/g
  let line = ''
  let last = 0
  for (let match = tokens.exec(html); match; match = tokens.exec(html)) {
    line += html.slice(last, match.index)
    last = tokens.lastIndex
    const token = match[0]
    if (token === '\n') {
      lines.push(line + '</span>'.repeat(open.length))
      line = open.join('')
    } else {
      if (token === '</span>') open.pop()
      else open.push(token)
      line += token
    }
  }
  lines.push(line + html.slice(last) + '</span>'.repeat(open.length))
  return lines
}

function highlightText(lines: string[], language: string): string[] | null {
  try {
    const html = splitHighlighted(hljs.highlight(lines.join('\n'), { language, ignoreIllegals: true }).value)
    return html.length === lines.length ? html : null
  } catch {
    return null
  }
}

/**
 * The lines of a diff as highlighted HTML (escaped by highlight.js), null where there is none. Each
 * hunk is highlighted as a whole, once as the old file (unchanged and removed lines) and once as the
 * new one (unchanged and added lines), so a line keeps the context of the lines around it.
 */
export function highlightDiff(lines: readonly DiffLine[], language: string): (string | null)[] | null {
  if (!hasLanguage(language)) return null
  let size = 0
  for (const line of lines) size += line.text.length + 1
  if (size > MAX_HIGHLIGHT_CHARS) return null
  const out: (string | null)[] = new Array<string | null>(lines.length).fill(null)
  const section = (start: number, end: number) => {
    const before: number[] = []
    const after: number[] = []
    for (let i = start; i < end; i++) {
      const kind = lines[i].kind
      if (kind !== 'add') before.push(i)
      if (kind !== 'del') after.push(i)
    }
    const oldHtml = before.some((i) => lines[i].kind === 'del') ? highlightText(before.map((i) => lines[i].text), language) : null
    const newHtml = after.length ? highlightText(after.map((i) => lines[i].text), language) : null
    after.forEach((i, k) => (out[i] = newHtml?.[k] ?? null))
    before.forEach((i, k) => {
      if (lines[i].kind === 'del') out[i] = oldHtml?.[k] ?? null
    })
  }
  let start = 0
  lines.forEach((line, i) => {
    if (line.kind !== 'hunk') return
    section(start, i)
    start = i + 1
  })
  section(start, lines.length)
  return out
}
