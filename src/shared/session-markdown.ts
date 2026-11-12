import { modelName } from './model-name'
import { promptParts } from './pasted'
import type { SessionSummary, TranscriptMessage, TranscriptToolCall } from './types'

export interface SessionMarkdownOptions {
  /** Older messages that aren't in `messages` (the history is longer than an export takes). */
  omitted?: number
  /** For the times; the system's own without one. */
  timeZone?: string
}

/** A fence around `text` longer than any run of backticks in it, so nothing in it ends the block. */
export function fenced(text: string, language = ''): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${text.replace(/\n+$/, '')}\n${fence}`
}

/** `text` as code within a line: on one line, with enough backticks around it. */
export function inlineCode(text: string): string {
  const line = text.replace(/\s*\n\s*/g, ' ').trim()
  const longest = Math.max(0, ...[...line.matchAll(/`+/g)].map((m) => m[0].length))
  const ticks = '`'.repeat(longest + 1)
  const pad = longest > 0 || line.startsWith('`') || line.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${line}${pad}${ticks}`
}

/** One line of text that Markdown shows as it is (a title, a model's name). */
function plain(text: string): string {
  return text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/([\\`*_[\]<>#|])/g, '\\$1')
    .trim()
}

/** A file name for the export: the title without what Windows doesn't take in a name (also not a device's). */
export function markdownFileName(title: string): string {
  const name = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '')
  if (!name || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(name)) return 'Session.md'
  return `${name}.md`
}

function toolLine(tool: TranscriptToolCall): string {
  const parts = [`**${plain(tool.name)}**`]
  const what = tool.command ?? tool.summary
  if (what) parts.push(inlineCode(what))
  if (tool.detail) parts.push(plain(tool.detail))
  if (tool.description) parts.push(`– ${plain(tool.description)}`)
  if (tool.status === 'error') parts.push('(Fehler)')
  return `- ${parts.join(' ')}`
}

/** What the user wrote: typed text as it is, pasted text in a block of its own. */
function promptBody(text: string): string {
  return promptParts(text)
    .map((part) => (part.kind === 'pasted' ? fenced(part.text) : part.text))
    .join('\n\n')
}

/**
 * A session's history as a Markdown document, as the sessions page shows it: what it is about first
 * (folder, branch, model, when), then the messages by day, each author's turn under a heading of its
 * own. Claude's tool calls are a list under its answer.
 */
export function sessionMarkdown(
  summary: SessionSummary,
  messages: readonly TranscriptMessage[],
  options: SessionMarkdownOptions = {},
): string {
  const { timeZone } = options
  const dateTime = new Intl.DateTimeFormat('de', { dateStyle: 'medium', timeStyle: 'short', timeZone })
  const dayFormat = new Intl.DateTimeFormat('de', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone })
  const timeFormat = new Intl.DateTimeFormat('de', { hour: '2-digit', minute: '2-digit', timeZone })
  const at = (iso: string | null) => {
    const ms = iso ? Date.parse(iso) : NaN
    return Number.isNaN(ms) ? null : ms
  }

  const blocks: string[] = [`# ${plain(summary.title) || 'Session'}`]
  const facts: string[] = []
  if (summary.cwd) facts.push(`- **Ordner:** ${inlineCode(summary.cwd)}`)
  if (summary.worktree) {
    const branch = summary.worktree.branch ? ` (Branch ${inlineCode(summary.worktree.branch)})` : ''
    facts.push(`- **Worktree:** ${inlineCode(summary.worktree.name)}${branch}`)
  } else if (summary.gitBranch) facts.push(`- **Branch:** ${inlineCode(summary.gitBranch)}`)
  if (summary.model) facts.push(`- **Modell:** ${plain(modelName(summary.model) ?? summary.model)}`)
  const created = at(summary.createdAt)
  const updated = at(summary.updatedAt)
  if (created !== null) facts.push(`- **Begonnen:** ${dateTime.format(created)}`)
  if (updated !== null) facts.push(`- **Zuletzt aktiv:** ${dateTime.format(updated)}`)
  if (summary.tags.length) facts.push(`- **Tags:** ${summary.tags.map(plain).join(', ')}`)
  facts.push(`- **Session-ID:** ${inlineCode(summary.id)}`)
  blocks.push(facts.join('\n'))
  if (options.omitted) {
    const count = options.omitted.toLocaleString('de')
    blocks.push(
      `> ${options.omitted === 1 ? 'Die älteste Nachricht fehlt' : `Die ältesten ${count} Nachrichten fehlen`}, der Verlauf ist zu lang.`,
    )
  }

  let day = ''
  /** Who wrote the message before: the next one by the same author goes on under the same heading. */
  let author: 'user' | 'claude' | null = null
  for (const message of messages) {
    const ms = at(message.timestamp)
    if (ms !== null) {
      const label = dayFormat.format(ms)
      if (label !== day) {
        day = label
        author = null
        blocks.push(`## ${label}`)
      }
    }
    const time = ms !== null ? timeFormat.format(ms) : null
    const heading = (who: 'user' | 'claude', ...extra: (string | null)[]) => {
      if (author === who) return
      author = who
      blocks.push(`### ${[who === 'user' ? 'Du' : 'Claude', ...extra, time].filter(Boolean).join(' · ')}`)
    }

    switch (message.kind) {
      case 'compact':
        author = null
        blocks.push('---', `*${plain(message.text)}*`)
        break
      case 'summary':
        author = null
        blocks.push(`<details>\n<summary>Zusammenfassung des bisherigen Gesprächs</summary>\n\n${message.text.trim()}\n\n</details>`)
        break
      case 'task': {
        author = null
        const state = message.failed ? ' (fehlgeschlagen)' : ''
        blocks.push(`**Hintergrundaufgabe${state}${time ? ` · ${time}` : ''}:** ${plain(message.text)}`)
        if (message.output) blocks.push(message.output.trim())
        break
      }
      case 'command':
      case 'shell':
        heading('user')
        blocks.push(fenced(message.kind === 'shell' ? `! ${message.text}` : message.text, message.kind === 'shell' ? 'bash' : ''))
        if (message.output) blocks.push(`${message.failed ? 'Ausgabe (mit Fehlern):' : 'Ausgabe:'}\n\n${fenced(message.output)}`)
        break
      default:
        if (message.role === 'user') {
          heading('user')
          blocks.push(promptBody(message.text))
        } else {
          heading('claude', message.model && plain(modelName(message.model) ?? message.model))
          if (message.text.trim()) blocks.push(message.text.trim())
          if (message.tools.length) blocks.push(message.tools.map(toolLine).join('\n'))
        }
    }
  }
  return `${blocks.filter((block) => block.trim()).join('\n\n')}\n`
}
