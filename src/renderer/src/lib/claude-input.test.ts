import { describe, expect, it } from 'vitest'
import { claudeInputAt } from './claude-input'

const RULE = '─'.repeat(40)

/** A screen with Claude Code's input box at line 2 and `below` under it. */
function screen(input: string, below: string[] = []): string[] {
  return [' ▐▛███▛█   Claude Code v2.1.322', RULE, `❯ ${input}`, RULE, ...below, '  ⏵⏵ auto mode on (shift+tab to cycle)']
}

describe('claudeInputAt', () => {
  it('reads the command typed', () => {
    expect(claudeInputAt(screen('/diff '), 2)).toEqual({ text: '/diff', command: '/diff' })
    // As Claude Code draws it: a no-break space after the prompt.
    expect(claudeInputAt([RULE, '❯ /diff ', RULE, '  ❯ /diff   Toggle the diff panel'], 1)).toEqual({ text: '/diff', command: '/diff' })
    expect(claudeInputAt(screen('/diff HEAD~1'), 2)).toEqual({ text: '/diff HEAD~1', command: '/diff' })
  })

  it('takes the command marked in the list, which Enter runs', () => {
    const list = ['  ❯ /diff                       View uncommitted changes', '    /verify                     Try your change']
    expect(claudeInputAt(screen('/dif', list), 2)?.command).toBe('/diff')
    const other = ['    /diff                       View uncommitted changes', '  ❯ /verify                     Try your change']
    expect(claudeInputAt(screen('/diff', other), 2)?.command).toBe('/verify')
  })

  it('is no command for a message', () => {
    expect(claudeInputAt(screen('zeig mir /diff'), 2)).toEqual({ text: 'zeig mir /diff', command: null })
  })

  it('is nothing where the cursor isn’t in the box', () => {
    const lines = screen('/diff')
    expect(claudeInputAt(lines, 0)).toBeNull()
    // An earlier prompt in the conversation, not between rules.
    expect(claudeInputAt(['● Fertig.', '❯ /diff', '  ⎿  Diff panel shown'], 1)).toBeNull()
    // A message of several lines.
    expect(claudeInputAt([RULE, '❯ /diff', '  und mehr', RULE], 1)).toBeNull()
    // A choice in a dialog.
    expect(claudeInputAt(['Do you want to proceed?', '❯ 1. Yes', '  2. No'], 1)).toBeNull()
  })
})
