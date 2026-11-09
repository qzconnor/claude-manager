import hljs from 'highlight.js/lib/core'
import type { LanguageFn } from 'highlight.js'
import type { DiffLine } from './file-diff'

/**
 * Syntax highlighting for the file diff, with highlight.js: a language is loaded the first time a
 * file of it is shown. The colours come from the terminal's theme (`.syntax` in main.css).
 */

const LOADERS: Record<string, () => Promise<{ default: LanguageFn }>> = {
  apache: () => import('highlight.js/lib/languages/apache'),
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  cmake: () => import('highlight.js/lib/languages/cmake'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  dart: () => import('highlight.js/lib/languages/dart'),
  diff: () => import('highlight.js/lib/languages/diff'),
  django: () => import('highlight.js/lib/languages/django'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  dos: () => import('highlight.js/lib/languages/dos'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  fsharp: () => import('highlight.js/lib/languages/fsharp'),
  go: () => import('highlight.js/lib/languages/go'),
  gradle: () => import('highlight.js/lib/languages/gradle'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
  handlebars: () => import('highlight.js/lib/languages/handlebars'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  julia: () => import('highlight.js/lib/languages/julia'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  latex: () => import('highlight.js/lib/languages/latex'),
  less: () => import('highlight.js/lib/languages/less'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  nix: () => import('highlight.js/lib/languages/nix'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  ocaml: () => import('highlight.js/lib/languages/ocaml'),
  perl: () => import('highlight.js/lib/languages/perl'),
  php: () => import('highlight.js/lib/languages/php'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  properties: () => import('highlight.js/lib/languages/properties'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  python: () => import('highlight.js/lib/languages/python'),
  r: () => import('highlight.js/lib/languages/r'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scss: () => import('highlight.js/lib/languages/scss'),
  sql: () => import('highlight.js/lib/languages/sql'),
  stylus: () => import('highlight.js/lib/languages/stylus'),
  swift: () => import('highlight.js/lib/languages/swift'),
  twig: () => import('highlight.js/lib/languages/twig'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  vbnet: () => import('highlight.js/lib/languages/vbnet'),
  vim: () => import('highlight.js/lib/languages/vim'),
  vue: () => import('./hljs-vue'),
  x86asm: () => import('highlight.js/lib/languages/x86asm'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
}

/** Languages embedded in another one: HTML, Vue and Svelte files have scripts and styles. */
const EMBEDDED: Record<string, string[]> = {
  xml: ['javascript', 'typescript', 'css'],
  vue: ['xml', 'javascript', 'typescript', 'css', 'scss', 'less'],
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
  jsonl: 'json',
  webmanifest: 'json',
  ipynb: 'json',
  vue: 'vue',
  svelte: 'vue',
  html: 'xml',
  htm: 'xml',
  xhtml: 'xml',
  xml: 'xml',
  svg: 'xml',
  xaml: 'xml',
  csproj: 'xml',
  fsproj: 'xml',
  vbproj: 'xml',
  props: 'xml',
  targets: 'xml',
  resx: 'xml',
  plist: 'xml',
  razor: 'xml',
  cshtml: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  styl: 'stylus',
  md: 'markdown',
  mdx: 'markdown',
  mdc: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  sc: 'scala',
  sbt: 'scala',
  groovy: 'groovy',
  gvy: 'groovy',
  gradle: 'gradle',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  ino: 'cpp',
  m: 'objectivec',
  mm: 'objectivec',
  cs: 'csharp',
  fs: 'fsharp',
  fsi: 'fsharp',
  fsx: 'fsharp',
  vb: 'vbnet',
  php: 'php',
  rb: 'ruby',
  gemspec: 'ruby',
  rake: 'ruby',
  pl: 'perl',
  pm: 'perl',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hrl: 'erlang',
  hs: 'haskell',
  ml: 'ocaml',
  mli: 'ocaml',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  edn: 'clojure',
  jl: 'julia',
  r: 'r',
  lua: 'lua',
  dart: 'dart',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  ini: 'ini',
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'properties',
  cmake: 'cmake',
  nix: 'nix',
  vim: 'vim',
  tex: 'latex',
  asm: 'x86asm',
  hbs: 'handlebars',
  handlebars: 'handlebars',
  mustache: 'handlebars',
  twig: 'twig',
  j2: 'django',
  jinja: 'django',
  jinja2: 'django',
  diff: 'diff',
  patch: 'diff',
}

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  'nginx.conf': 'nginx',
  '.htaccess': 'apache',
  gemfile: 'ruby',
  rakefile: 'ruby',
  vagrantfile: 'ruby',
  podfile: 'ruby',
  jenkinsfile: 'groovy',
  '.vimrc': 'vim',
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
 * Highlights the lines of the diff as their file shows them in `whole` (the diff of the whole file,
 * each line in it): the old file and the new one are highlighted from their first line, so a line
 * in the middle of a Vue file's script, a comment or a template string is code of that kind. Null
 * when `whole` doesn't fit the lines (made at another moment) or is too big.
 */
function highlightInFile(lines: readonly DiffLine[], whole: readonly DiffLine[], language: string): (string | null)[] | null {
  const oldFile: string[] = []
  const newFile: string[] = []
  let size = 0
  for (const line of whole) {
    if (line.kind === 'hunk') continue
    if (line.old !== null) oldFile[line.old - 1] = line.text
    if (line.new !== null) newFile[line.new - 1] = line.text
    size += line.text.length + 1
  }
  if (size > MAX_HIGHLIGHT_CHARS) return null
  const same = (file: string[], number: number | null, text: string) => number !== null && file[number - 1] === text
  if (!lines.every((line) => line.kind === 'hunk' || same(line.kind === 'del' ? oldFile : newFile, line.kind === 'del' ? line.old : line.new, line.text))) {
    return null
  }
  // A file the diff shows in parts has no gaps in `whole`; the old one only matters with removed lines.
  const newHtml = highlightText(Array.from(newFile, (text) => text ?? ''), language)
  const oldHtml = lines.some((line) => line.kind === 'del') ? highlightText(Array.from(oldFile, (text) => text ?? ''), language) : null
  if (!newHtml) return null
  return lines.map((line) => {
    if (line.kind === 'hunk') return null
    if (line.kind === 'del') return line.old !== null ? (oldHtml?.[line.old - 1] ?? null) : null
    return line.new !== null ? (newHtml[line.new - 1] ?? null) : null
  })
}

/**
 * The lines of a diff as highlighted HTML (escaped by highlight.js), null where there is none. With
 * `whole`, the diff of the whole file, each line is highlighted in its file. Otherwise each hunk is
 * highlighted as a whole, once as the old file (unchanged and removed lines) and once as the new one
 * (unchanged and added lines), so a line keeps the context of the lines around it.
 */
export function highlightDiff(lines: readonly DiffLine[], language: string, whole?: readonly DiffLine[] | null): (string | null)[] | null {
  if (!hasLanguage(language)) return null
  if (whole && whole !== lines) {
    const inFile = highlightInFile(lines, whole, language)
    if (inFile) return inFile
  }
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
