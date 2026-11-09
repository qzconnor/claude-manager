import { homedir } from 'node:os'
import { resolve } from 'node:path'

/**
 * The files a shell command of Claude's names, read from its text (for the file tree): what it reads
 * (`cat`, `head`, `sed -n`, `Get-Content` …), searches (`grep`, `rg`, `Select-String` …) and writes
 * (`sed -i`, `tee`, `> file`, `Set-Content` …). A guess from the words alone: every path still has to
 * be an existing file to count, so a pattern or a number taken for a path drops out. What a script or
 * program writes the file tree learns by watching the folder while the command runs.
 */
export interface ShellFiles {
  reads: string[]
  searches: string[]
  writes: string[]
}

/** The most paths taken from one command. */
const MAX_PATHS = 20

const READING = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'batcat',
  'nl',
  'wc',
  'sort',
  'uniq',
  'tac',
  'cut',
  'column',
  'fold',
  'diff',
  'cmp',
  'comm',
  'file',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'strings',
  'xxd',
  'od',
  'hexdump',
  'jq',
  'yq',
  'awk',
  'gawk',
  'type',
  'get-content',
  'gc',
  'format-hex',
  'get-filehash',
  'import-csv',
])
const SEARCHING = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'findstr', 'select-string', 'sls'])
const WRITING = new Set(['tee', 'touch', 'truncate', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc'])
/** The last argument is written, the others read (copy) or gone (move). */
const COPYING = new Set(['cp', 'copy', 'copy-item', 'cpi'])
const MOVING = new Set(['mv', 'move', 'move-item', 'mi'])
const CHANGING_DIR = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl'])
/** Git commands that read the files they name. */
const GIT_READING = new Set(['diff', 'show', 'log', 'blame', 'annotate'])
/** Words before the command itself: commands that run it, and the shell's own words. */
const PREFIXES = new Set(['sudo', 'command', 'builtin', 'exec', 'env', 'time', 'nice', 'nohup', 'stdbuf', '{', '}', '!'])
const KEYWORDS = new Set(['if', 'elif', 'then', 'else', 'do', 'while', 'until'])
/** PowerShell's parameters whose value is a path. */
const PATH_PARAMETERS = new Set(['-path', '-literalpath', '-filepath', '-destination'])
/** Targets of a redirection that are no file. */
const NO_FILE = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', 'nul', '$null'])

type Token = { word: string } | { op: string }

/**
 * The words and operators of a command line. Bash: quotes, backslash escapes, comments; heredoc
 * bodies are left out. PowerShell: its quotes, the backtick as escape, here-strings left out.
 */
export function shellTokens(command: string, powershell = false): Token[] {
  const text = withoutHeredocs(command, powershell)
  const tokens: Token[] = []
  let word = ''
  let inWord = false
  const end = () => {
    if (inWord) tokens.push({ word })
    word = ''
    inWord = false
  }
  const op = (value: string) => {
    end()
    tokens.push({ op: value })
  }
  const escape = powershell ? '`' : '\\'
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === escape && i + 1 < text.length) {
      // A line continuation joins the lines.
      if (text[i + 1] !== '\n') {
        word += text[i + 1]
        inWord = true
      }
      i++
    } else if (c === "'") {
      const close = powershell ? closingSingle(text, i + 1) : text.indexOf("'", i + 1)
      const stop = close === -1 ? text.length : close
      word += powershell ? text.slice(i + 1, stop).replaceAll("''", "'") : text.slice(i + 1, stop)
      inWord = true
      i = stop
    } else if (c === '"') {
      let j = i + 1
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === escape && j + 1 < text.length) word += text[++j]
        else word += text[j]
      }
      inWord = true
      i = j
    } else if (c === ' ' || c === '\t' || c === '\r') {
      end()
    } else if (c === '\n' || c === ';' || c === '(' || c === ')' || (!powershell && c === '`')) {
      op(';')
    } else if (c === '#' && !inWord) {
      const next = text.indexOf('\n', i)
      i = next === -1 ? text.length : next - 1
    } else if (c === '$' && text[i + 1] === '(') {
      op(';')
      i++
    } else if (c === '|' || c === '&') {
      if (c === '&' && text[i + 1] === '>') {
        const append = text[i + 2] === '>'
        op(append ? '>>' : '>')
        i += append ? 2 : 1
      } else {
        op(text[i + 1] === c ? c + c : c)
        if (text[i + 1] === c) i++
      }
    } else if (c === '>' || c === '<') {
      // A file descriptor before it (`2>`) is no word of the command.
      if (inWord && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      }
      let value = c
      while (text[i + 1] === c && value.length < 3) value += text[++i]
      if (text[i + 1] === '&' || text[i + 1] === '|') value += text[++i]
      op(value)
    } else {
      word += c
      inWord = true
    }
  }
  end()
  return tokens
}

/** The end of a single-quoted PowerShell string, where `''` stands for a quote. */
function closingSingle(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== "'") continue
    if (text[i + 1] === "'") i++
    else return i
  }
  return -1
}

const HEREDOC_RE = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/g

/** The command without the bodies of heredocs (bash) or here-strings (PowerShell): text, no commands. */
function withoutHeredocs(command: string, powershell: boolean): string {
  const lines = command.split('\n')
  const kept: string[] = []
  const pending: string[] = []
  let hereString: string | null = null
  for (const line of lines) {
    if (hereString !== null) {
      if (line.startsWith(hereString)) hereString = null
      continue
    }
    if (pending.length > 0) {
      if (line.trim() === pending[0]) pending.shift()
      continue
    }
    kept.push(line)
    if (powershell) {
      const open = /@(['"])\s*$/.exec(line)
      if (open) hereString = `${open[1]}@`
    } else {
      for (const match of line.matchAll(HEREDOC_RE)) pending.push(match[2]!)
    }
  }
  return kept.join('\n')
}

interface Command {
  words: string[]
  redirects: { op: string; target: string }[]
}

function commandsOf(tokens: Token[]): Command[] {
  const commands: Command[] = []
  let current: Command = { words: [], redirects: [] }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if ('word' in token) {
      current.words.push(token.word)
      continue
    }
    if (token.op.startsWith('>') || token.op.startsWith('<')) {
      const next = tokens[i + 1]
      if (next && 'word' in next) {
        current.redirects.push({ op: token.op, target: next.word })
        i++
      }
      continue
    }
    if (current.words.length || current.redirects.length) commands.push(current)
    current = { words: [], redirects: [] }
  }
  if (current.words.length || current.redirects.length) commands.push(current)
  return commands
}

/** The files a command line names, as absolute paths; relative ones from `cwd`, after any `cd` in it. */
export function shellFiles(command: string, cwd: string, powershell = false, windows = process.platform === 'win32'): ShellFiles {
  const files: ShellFiles = { reads: [], searches: [], writes: [] }
  let dir = cwd
  let count = 0
  const add = (list: string[], word: string | undefined) => {
    if (word === undefined || count >= MAX_PATHS) return
    const path = toPath(word, dir, windows)
    if (path && !list.includes(path)) {
      list.push(path)
      count++
    }
  }
  for (const { words, redirects } of commandsOf(shellTokens(command, powershell))) {
    for (const { op, target } of redirects) {
      if (op.endsWith('&') || NO_FILE.has(target.toLowerCase())) continue
      // A here-string (`<<<`) is text, a heredoc's word its end.
      if (op.startsWith('<<')) continue
      add(op.startsWith('>') ? files.writes : files.reads, target)
    }
    let start = 0
    while (
      start < words.length &&
      (/^[A-Za-z_]\w*=/.test(words[start]!) || PREFIXES.has(words[start]!) || (!powershell && KEYWORDS.has(words[start]!)))
    )
      start++
    const name = commandName(words[start])
    if (!name) continue
    const args = words.slice(start + 1)
    if (CHANGING_DIR.has(name)) {
      const target = operands(args, powershell)[0]
      const path = target && target !== '-' ? toPath(target, dir, windows) : null
      if (path) dir = path
      continue
    }
    if (name === 'xargs') continue
    if (name === 'git') {
      gitFiles(args, (word) => add(files.reads, word), (word) => add(files.searches, word))
      continue
    }
    if (name === 'sed') {
      const inPlace = args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'))
      for (const word of operands(args, powershell)) add(inPlace ? files.writes : files.reads, word)
      continue
    }
    const list = READING.has(name)
      ? files.reads
      : SEARCHING.has(name)
        ? files.searches
        : WRITING.has(name)
          ? files.writes
          : null
    if (list) {
      for (const word of operands(args, powershell)) add(list, word)
      continue
    }
    if (COPYING.has(name) || MOVING.has(name)) {
      const words = operands(args, powershell)
      if (words.length < 2) continue
      if (COPYING.has(name)) for (const word of words.slice(0, -1)) add(files.reads, word)
      add(files.writes, words.at(-1))
    }
  }
  return files
}

/** A command's name: lower case, without its folder and `.exe`. */
function commandName(word: string | undefined): string | null {
  if (!word) return null
  const base = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1).toLowerCase()
  return base.endsWith('.exe') ? base.slice(0, -4) : base || null
}

/**
 * The arguments that may be paths: options left out (up to `--`), the values of PowerShell's path
 * parameters kept.
 */
function operands(args: readonly string[], powershell: boolean): string[] {
  const out: string[] = []
  let options = true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (options && arg === '--') {
      options = false
      continue
    }
    if (options && arg.startsWith('-') && arg !== '-') {
      if (powershell && PATH_PARAMETERS.has(arg.toLowerCase()) && i + 1 < args.length) out.push(args[++i]!)
      continue
    }
    out.push(arg)
  }
  return out
}

function gitFiles(args: readonly string[], read: (word: string) => void, search: (word: string) => void): void {
  let i = 0
  // Options before the subcommand, some with a value (`-C dir`, `-c key=value`).
  while (i < args.length && args[i]!.startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  const sub = args[i]
  if (sub === 'grep') for (const word of operands(args.slice(i + 1), false)) search(word)
  else if (sub && GIT_READING.has(sub)) for (const word of operands(args.slice(i + 1), false)) read(word)
}

/**
 * A word as an absolute path, or null for one that can't be (a variable, a glob, a URL). Git Bash
 * writes Windows drives as `/c/…`.
 */
function toPath(word: string, dir: string, windows: boolean): string | null {
  if (!word || word === '-' || /[*?$<>|]/.test(word) || /^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return null
  let path = word
  if (path === '~' || path.startsWith('~/')) path = homedir() + path.slice(1)
  else if (windows) path = path.replace(/^\/([a-zA-Z])(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`)
  return resolve(dir, path)
}
