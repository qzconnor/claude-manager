import type { ClaudeSettings } from '@shared/types'
import type { McpTool, McpToolResult } from '../mcp-protocol'
import { type Args, ToolError } from '../tool-args'
import { limitsTools } from './limits'
import { sessionTools } from './sessions'
import { Shells, shellTools } from './shells'
import type { AppToolContext, AppToolDefinition, AppToolGroup, AppToolsDeps } from './tool'

/**
 * Tools of the app's MCP server for Claude Manager itself (next to the browser's): a session reads
 * the limits of its account, searches and reads earlier sessions, and drives shell tabs it opened.
 * Each group has a switch in the settings (tab "Werkzeuge"); the shells are off by default, since
 * what runs in them is outside Claude Code's permissions. The tools of each group are in the files
 * next to this one.
 */

const SETTING_LABELS: Record<AppToolGroup, string> = {
  limits: 'Eigene Limits lesen',
  sessions: 'Sessions durchsuchen',
  shell: 'Shell-Tabs steuern',
}

/** The groups the settings switch on. */
export function enabledAppGroups(claude: ClaudeSettings): Set<AppToolGroup> {
  const groups = new Set<AppToolGroup>()
  if (claude.limitsTool) groups.add('limits')
  if (claude.sessionsTool) groups.add('sessions')
  if (claude.shellTools) groups.add('shell')
  return groups
}

/** The groups whose tools Claude Code may use without asking (`--allowedTools`): reading always, shells when allowed. */
export function allowedAppGroups(claude: ClaudeSettings): Set<AppToolGroup> {
  const groups = enabledAppGroups(claude)
  if (!claude.shellToolsAllowed) groups.delete('shell')
  return groups
}

/** What the server tells Claude about the tools of these groups. */
export function appInstructions(groups: ReadonlySet<AppToolGroup>): string {
  const lines = ['Claude Manager, the app this session runs in, also gives you tools for the app itself:']
  if (groups.has('limits')) lines.push('- limits: how much of the usage limits of your account is used and when they reset; check it before long tasks.')
  if (groups.has('sessions')) {
    lines.push('- sessions_search and session_read: earlier Claude Code sessions of the user, e.g. to look up how something was solved or decided before.')
  }
  if (groups.has('shell')) {
    lines.push(
      '- shell_open, shell_input, shell_output, shell_list, shell_close: shell tabs next to this session that the user sees. Use them for processes that keep running (dev servers, watchers) and read their output later; for one-off commands keep using your own shell tool.',
    )
  }
  return lines.join('\n')
}

const TOOLS: AppToolDefinition<never>[] = [...limitsTools, ...sessionTools, ...shellTools]

/** The names of the tools of these groups. */
export function appToolNames(groups: ReadonlySet<AppToolGroup>): string[] {
  return TOOLS.filter((t) => groups.has(t.group)).map((t) => t.name)
}

/** The group of a tool of the app; null for other names (e.g. the browser's). */
export function appToolGroup(name: string): AppToolGroup | null {
  return TOOLS.find((t) => t.name === name)?.group ?? null
}

/** Checks a tool's arguments as its call does (for tests). */
export function parseAppToolArgs(name: string, args: Args): unknown {
  const definition = TOOLS.find((t) => t.name === name) as AppToolDefinition<unknown> | undefined
  if (!definition) throw new ToolError(`Unknown tool: ${name}`)
  return definition.parse(args)
}

export class AppTools {
  private readonly context: AppToolContext

  constructor(deps: AppToolsDeps) {
    this.context = { deps, shells: new Shells(deps.terminals) }
  }

  list(groups: ReadonlySet<AppToolGroup>): McpTool[] {
    return TOOLS.filter((t) => groups.has(t.group)).map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: { type: 'object', properties: t.properties, ...(t.required ? { required: t.required } : {}), additionalProperties: false },
      annotations: { title: t.title, readOnlyHint: t.readOnly === true, destructiveHint: t.destructive === true, openWorldHint: false },
    }))
  }

  /** Whether `name` is one of the app's tools (switched on or not). */
  has(name: string): boolean {
    return appToolGroup(name) !== null
  }

  async call(sessionId: string, name: string, args: Args): Promise<McpToolResult> {
    const definition = TOOLS.find((t) => t.name === name) as AppToolDefinition<unknown> | undefined
    if (!definition) throw new ToolError(`Unknown tool: ${name}`)
    if (!enabledAppGroups(this.context.deps.settings.get().claude).has(definition.group)) {
      throw new ToolError(
        `The user turned "${SETTING_LABELS[definition.group]}" off in the settings of Claude Manager (Einstellungen › Werkzeuge).`,
      )
    }
    const session = this.context.deps.terminals.list().find((t) => t.id === sessionId)
    if (!session) throw new ToolError('This session is no longer open in Claude Manager.')
    const params = definition.parse(args)
    const text = await definition.run(this.context, session, params)
    return { content: [{ type: 'text', text }] }
  }
}
