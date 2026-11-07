import type { TerminalActivity } from '@shared/types'

/** What Claude does with a tool, in words, for the hover card of a tab. */
const TOOL_LABELS: Record<string, string> = {
  Bash: 'Führt einen Befehl aus',
  PowerShell: 'Führt einen Befehl aus',
  Read: 'Liest eine Datei',
  Edit: 'Bearbeitet eine Datei',
  MultiEdit: 'Bearbeitet eine Datei',
  Write: 'Schreibt eine Datei',
  NotebookEdit: 'Bearbeitet ein Notebook',
  Grep: 'Durchsucht Dateien',
  Glob: 'Sucht Dateien',
  WebFetch: 'Lädt eine Webseite',
  WebSearch: 'Sucht im Web',
  Agent: 'Startet einen Subagent',
  Task: 'Startet einen Subagent',
  Skill: 'Lädt einen Skill',
  TodoWrite: 'Plant Aufgaben',
}

/** The tool Claude runs, as the hover card shows it: what it does, and on what. */
export function activityLabel(activity: TerminalActivity): { label: string; detail: string | null } {
  const known = TOOL_LABELS[activity.tool]
  if (known) return { label: known, detail: activity.detail }
  // `mcp__<server>__<tool>`; server names may contain underscores, tool names too.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(activity.tool)
  if (mcp) return { label: `Nutzt ${mcp[2]} (${mcp[1]})`, detail: activity.detail }
  return { label: `Nutzt ${activity.tool}`, detail: activity.detail }
}

/** "seit 12 s", "seit 3 min"; nothing for the first seconds. */
export function activityDuration(since: string, now: number): string | null {
  const seconds = Math.floor((now - Date.parse(since)) / 1000)
  if (!Number.isFinite(seconds) || seconds < 5) return null
  if (seconds < 60) return `seit ${seconds} s`
  return `seit ${Math.floor(seconds / 60)} min`
}
