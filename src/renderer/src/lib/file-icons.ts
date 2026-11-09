import {
  BinaryIcon,
  BookOpenIcon,
  BrainIcon,
  CodeXmlIcon,
  ContainerIcon,
  DatabaseIcon,
  FileArchiveIcon,
  FileBracesIcon,
  FileCodeIcon,
  FileCogIcon,
  FileIcon,
  FileImageIcon,
  FileKeyIcon,
  FileMusicIcon,
  FileSpreadsheetIcon,
  FileSymlinkIcon,
  FileTerminalIcon,
  FileTextIcon,
  FileTypeIcon,
  FileVideoCameraIcon,
  FileXIcon,
  FolderArchiveIcon,
  FolderCheckIcon,
  FolderCodeIcon,
  FolderCogIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  FolderOutputIcon,
  FolderSymlinkIcon,
  GitBranchIcon,
  KeyRoundIcon,
  LockIcon,
  PackageIcon,
  PaletteIcon,
  ScrollTextIcon,
  TerminalIcon,
} from '@lucide/vue'
import type { Component } from 'vue'

/** The symbol of an entry of the file tree and its colour (a text colour class). */
export interface FileIconInfo {
  icon: Component
  class: string
}

const icon = (component: Component, color: string): FileIconInfo => ({ icon: component, class: color })

const MUTED = 'text-muted-foreground'

const FOLDERS: Record<string, FileIconInfo> = {}
for (const [names, info] of [
  [['src', 'source', 'lib', 'app', 'packages'], icon(FolderCodeIcon, 'text-sky-500')],
  [['.github', '.gitlab', '.githooks', '.husky'], icon(FolderGit2Icon, 'text-orange-500')],
  [['.vscode', '.idea', '.claude', '.agents', '.config', 'config', '.devcontainer'], icon(FolderCogIcon, 'text-violet-500')],
  [['node_modules', 'vendor', '.venv', 'venv', 'bower_components'], icon(FolderArchiveIcon, 'text-emerald-600/80')],
  [['dist', 'build', 'out', 'target', 'release', '.next', '.nuxt', 'coverage'], icon(FolderOutputIcon, 'text-amber-600/80')],
  [['test', 'tests', '__tests__', 'spec', 'e2e'], icon(FolderCheckIcon, 'text-green-500')],
] as const) {
  for (const name of names) FOLDERS[name] = info
}

/** By the whole name, in lower case. */
const NAMES: Record<string, FileIconInfo> = {}
for (const [names, info] of [
  // Instructions for Claude and other agents, like the brain of the claude-code-filetree plugin.
  [['claude.md', 'claude.local.md', 'agents.md', 'agents.local.md'], icon(BrainIcon, 'text-primary')],
  [['package.json'], icon(PackageIcon, 'text-red-500')],
  [['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'cargo.lock', 'poetry.lock', 'composer.lock', 'gemfile.lock', 'uv.lock'], icon(LockIcon, MUTED)],
  [['.gitignore', '.gitattributes', '.gitmodules', '.gitkeep', '.mailmap'], icon(GitBranchIcon, 'text-orange-500')],
  [['dockerfile', '.dockerignore', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'], icon(ContainerIcon, 'text-sky-500')],
  [['license', 'licence', 'license.md', 'license.txt', 'copying'], icon(ScrollTextIcon, 'text-amber-500')],
  [['readme.md', 'readme', 'readme.txt'], icon(BookOpenIcon, 'text-sky-400')],
  [['makefile', 'justfile', 'procfile'], icon(TerminalIcon, 'text-green-500')],
  [['.editorconfig', '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc', '.browserslistrc'], icon(FileCogIcon, MUTED)],
] as const) {
  for (const name of names) NAMES[name] = info
}

/** By the extension, in lower case. */
const EXTENSIONS: Record<string, FileIconInfo> = {}
for (const [extensions, info] of [
  [['ts', 'tsx', 'mts', 'cts'], icon(FileCodeIcon, 'text-blue-500')],
  [['js', 'jsx', 'mjs', 'cjs'], icon(FileCodeIcon, 'text-yellow-500')],
  [['vue'], icon(FileCodeIcon, 'text-emerald-500')],
  [['svelte', 'astro'], icon(FileCodeIcon, 'text-orange-500')],
  [['py', 'pyi', 'ipynb'], icon(FileCodeIcon, 'text-sky-500')],
  [['rs'], icon(FileCodeIcon, 'text-orange-600')],
  [['go'], icon(FileCodeIcon, 'text-cyan-500')],
  [['rb', 'erb'], icon(FileCodeIcon, 'text-red-500')],
  [['java', 'kt', 'kts', 'scala', 'groovy', 'gradle'], icon(FileCodeIcon, 'text-orange-500')],
  [['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'm', 'mm'], icon(FileCodeIcon, 'text-blue-400')],
  [['cs', 'fs', 'vb', 'csproj', 'sln'], icon(FileCodeIcon, 'text-violet-500')],
  [['php'], icon(FileCodeIcon, 'text-indigo-400')],
  [['swift', 'dart', 'lua', 'zig', 'ex', 'exs', 'elm', 'hs', 'clj', 'r', 'jl', 'pl'], icon(FileCodeIcon, 'text-teal-500')],
  [['html', 'htm', 'xml', 'xaml', 'xsd', 'plist'], icon(CodeXmlIcon, 'text-orange-500')],
  [['css', 'scss', 'sass', 'less', 'styl', 'pcss'], icon(PaletteIcon, 'text-sky-400')],
  [['json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'webmanifest'], icon(FileBracesIcon, 'text-yellow-500')],
  [['yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env'], icon(FileCogIcon, 'text-violet-400')],
  [['md', 'mdx', 'markdown', 'rst', 'adoc'], icon(FileTextIcon, 'text-sky-400')],
  [['txt', 'log', 'text'], icon(FileTextIcon, MUTED)],
  [['pdf'], icon(FileTextIcon, 'text-red-500')],
  [['sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd'], icon(FileTerminalIcon, 'text-green-500')],
  [['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'tif', 'tiff', 'heic', 'icns'], icon(FileImageIcon, 'text-purple-400')],
  [['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'], icon(FileVideoCameraIcon, 'text-pink-400')],
  [['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus'], icon(FileMusicIcon, 'text-pink-400')],
  [['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'xz', 'bz2', 'zst', 'asar'], icon(FileArchiveIcon, 'text-amber-600')],
  [['csv', 'tsv', 'xlsx', 'xls', 'ods'], icon(FileSpreadsheetIcon, 'text-green-600')],
  [['sql', 'db', 'sqlite', 'sqlite3', 'prisma'], icon(DatabaseIcon, 'text-amber-500')],
  [['lock'], icon(LockIcon, MUTED)],
  [['exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'node', 'o', 'obj', 'class', 'pyc'], icon(BinaryIcon, MUTED)],
  [['pem', 'key', 'crt', 'cer', 'p12', 'pfx', 'pub', 'gpg', 'asc'], icon(FileKeyIcon, 'text-yellow-500')],
  [['ttf', 'otf', 'woff', 'woff2', 'eot'], icon(FileTypeIcon, 'text-red-400')],
] as const) {
  for (const extension of extensions) EXTENSIONS[extension] = info
}

const FOLDER = icon(FolderIcon, MUTED)
const FOLDER_OPEN = icon(FolderOpenIcon, MUTED)
const FILE = icon(FileIcon, MUTED)
const LINKED_FOLDER = icon(FolderSymlinkIcon, 'text-sky-500')
const LINKED_FILE = icon(FileSymlinkIcon, 'text-sky-500')
const BROKEN_LINK = icon(FileXIcon, 'text-destructive')
const CLAUDE_RULE = NAMES['claude.md']!
const ENV = icon(KeyRoundIcon, 'text-yellow-500')
const CONFIG = icon(FileCogIcon, 'text-blue-400')

/** The symbol of a tree entry by its path (`/`-separated), whether it is a folder (open) or a link. */
export function fileIcon(path: string, entry: { dir: boolean; link: boolean; broken: boolean }, open = false): FileIconInfo {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (entry.broken) return BROKEN_LINK
  if (entry.dir) return FOLDERS[name] ?? (entry.link ? LINKED_FOLDER : open ? FOLDER_OPEN : FOLDER)
  if (entry.link) return LINKED_FILE
  const byName = NAMES[name]
  if (byName) return byName
  // Claude's rules (`.claude/rules/*.md`) are instructions for it as well.
  if (name.endsWith('.md') && /(^|\/)\.claude\/rules\//i.test(path)) return CLAUDE_RULE
  if (name === '.env' || name.startsWith('.env.')) return ENV
  if (name.startsWith('dockerfile')) return NAMES['dockerfile']!
  if (/^(tsconfig|jsconfig)(\..+)?\.json$/.test(name) || /\.config\.(c|m)?(j|t)s$/.test(name)) return CONFIG
  const dot = name.lastIndexOf('.')
  return (dot > 0 && EXTENSIONS[name.slice(dot + 1)]) || FILE
}
