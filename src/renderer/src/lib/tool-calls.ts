import {
  BotIcon,
  FilePenLineIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderSearchIcon,
  GlobeIcon,
  ListTodoIcon,
  MapIcon,
  MessageCircleQuestionIcon,
  NotebookPenIcon,
  PlugIcon,
  SearchIcon,
  SparklesIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from '@lucide/vue'
import type { Component } from 'vue'

/** Claude Code's tools by name; the others (and those of MCP servers) get a wrench or a plug. */
const ICONS: Record<string, Component> = {
  Bash: SquareTerminalIcon,
  PowerShell: SquareTerminalIcon,
  BashOutput: SquareTerminalIcon,
  KillShell: SquareTerminalIcon,
  Monitor: SquareTerminalIcon,
  Read: FileTextIcon,
  Write: FilePlusIcon,
  Edit: FilePenLineIcon,
  MultiEdit: FilePenLineIcon,
  NotebookEdit: NotebookPenIcon,
  Grep: SearchIcon,
  Glob: FolderSearchIcon,
  WebFetch: GlobeIcon,
  WebSearch: GlobeIcon,
  Agent: BotIcon,
  Task: BotIcon,
  TodoWrite: ListTodoIcon,
  TaskCreate: ListTodoIcon,
  TaskUpdate: ListTodoIcon,
  Skill: SparklesIcon,
  AskUserQuestion: MessageCircleQuestionIcon,
  ExitPlanMode: MapIcon,
  EnterPlanMode: MapIcon,
}

export function toolIcon(name: string): Component {
  return ICONS[name] ?? (name.startsWith('mcp__') ? PlugIcon : WrenchIcon)
}

/**
 * The name a call is shown with: that of the tool, for a tool of an MCP server (`mcp__server__tool`)
 * without the prefix, and the server apart.
 */
export function toolTitle(name: string): { title: string; server: string | null } {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? { title: mcp[2]!, server: mcp[1]! } : { title: name, server: null }
}

/** The language of a shell tool's command, for its highlighting; null for other tools. */
export function shellLanguage(name: string): 'bash' | 'powershell' | null {
  if (name === 'PowerShell') return 'powershell'
  return name === 'Bash' ? 'bash' : null
}

/** A file a tool works on (`file_path`, `notebook_path`), from the inputs of its call. */
export function toolFile(input: readonly { key: string; value: string }[]): string | null {
  return input.find((field) => field.key === 'file_path' || field.key === 'notebook_path')?.value ?? null
}

/** The value of one input of a call; null without. */
export function inputValue(input: readonly { key: string; value: string }[], key: string): string | null {
  return input.find((field) => field.key === key)?.value ?? null
}

/** The changes of an Edit (one) or a MultiEdit (each of `edits`), as text before and after. */
export function editsOf(name: string, input: readonly { key: string; value: string }[]): { before: string; after: string }[] {
  if (name === 'Edit') {
    const before = inputValue(input, 'old_string')
    const after = inputValue(input, 'new_string')
    return before !== null && after !== null ? [{ before, after }] : []
  }
  if (name !== 'MultiEdit') return []
  try {
    const edits = JSON.parse(inputValue(input, 'edits') ?? '[]') as unknown
    if (!Array.isArray(edits)) return []
    return edits.flatMap((edit: { old_string?: unknown; new_string?: unknown } | null) =>
      typeof edit?.old_string === 'string' && typeof edit.new_string === 'string' ? [{ before: edit.old_string, after: edit.new_string }] : [],
    )
  } catch {
    return []
  }
}
