import { describe, expect, it } from 'vitest'
import { activityDuration, activityLabel } from './activity'

const since = '2026-11-07T12:00:00.000Z'

describe('activityLabel', () => {
  it('says in words what Claude does with its own tools', () => {
    expect(activityLabel({ tool: 'Bash', detail: 'npm test', since })).toEqual({ label: 'Führt einen Befehl aus', detail: 'npm test' })
    expect(activityLabel({ tool: 'Edit', detail: 'src/a.ts', since }).label).toBe('Bearbeitet eine Datei')
  })

  it('names tools of MCP servers with their server', () => {
    expect(activityLabel({ tool: 'mcp__claude-manager__browser_click', detail: null, since })).toEqual({
      label: 'Nutzt browser_click (claude-manager)',
      detail: null,
    })
  })

  it('names other tools as they are', () => {
    expect(activityLabel({ tool: 'LSP', detail: 'hover', since }).label).toBe('Nutzt LSP')
  })
})

describe('activityDuration', () => {
  const at = (seconds: number) => Date.parse(since) + seconds * 1000

  it('says nothing for the first seconds', () => {
    expect(activityDuration(since, at(4))).toBeNull()
  })

  it('counts seconds, then minutes', () => {
    expect(activityDuration(since, at(12))).toBe('seit 12 s')
    expect(activityDuration(since, at(185))).toBe('seit 3 min')
  })
})
