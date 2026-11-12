import { PlugIcon, SquareTerminalIcon, WrenchIcon } from '@lucide/vue'
import { describe, expect, it } from 'vitest'
import { editsOf, shellLanguage, toolFile, toolIcon, toolTitle } from './tool-calls'

const input = (fields: Record<string, string>) => Object.entries(fields).map(([key, value]) => ({ key, value }))

describe('tool calls', () => {
  it('shows a tool of an MCP server by its own name, the server apart', () => {
    expect(toolTitle('mcp__claude-manager__browser_click')).toEqual({ title: 'browser_click', server: 'claude-manager' })
    expect(toolTitle('mcp__claude_ai_Gmail__search__threads')).toEqual({ title: 'search__threads', server: 'claude_ai_Gmail' })
    expect(toolTitle('Bash')).toEqual({ title: 'Bash', server: null })
  })

  it('gives each tool an icon, a plug to those of MCP servers and a wrench to unknown ones', () => {
    expect(toolIcon('Bash')).toBe(SquareTerminalIcon)
    expect(toolIcon('PowerShell')).toBe(SquareTerminalIcon)
    expect(toolIcon('mcp__x__y')).toBe(PlugIcon)
    expect(toolIcon('SomethingNew')).toBe(WrenchIcon)
  })

  it('highlights the commands of Bash and PowerShell in their language', () => {
    expect(shellLanguage('Bash')).toBe('bash')
    expect(shellLanguage('PowerShell')).toBe('powershell')
    expect(shellLanguage('Read')).toBeNull()
  })

  it('finds the file of a call', () => {
    expect(toolFile(input({ file_path: 'src/a.ts', content: 'x' }))).toBe('src/a.ts')
    expect(toolFile(input({ notebook_path: 'a.ipynb' }))).toBe('a.ipynb')
    expect(toolFile(input({ command: 'ls' }))).toBeNull()
  })

  it('takes the changes of an Edit and of each part of a MultiEdit', () => {
    expect(editsOf('Edit', input({ file_path: 'a', old_string: 'a', new_string: 'b' }))).toEqual([{ before: 'a', after: 'b' }])
    expect(editsOf('Edit', input({ file_path: 'a', old_string: 'a' }))).toEqual([])
    const edits = JSON.stringify([{ old_string: '1', new_string: '2' }, { old_string: 3 }, null, { old_string: '', new_string: 'x' }], null, 2)
    expect(editsOf('MultiEdit', input({ file_path: 'a', edits }))).toEqual([
      { before: '1', after: '2' },
      { before: '', after: 'x' },
    ])
    expect(editsOf('MultiEdit', input({ edits: 'not json' }))).toEqual([])
    expect(editsOf('Write', input({ content: 'x' }))).toEqual([])
  })
})
