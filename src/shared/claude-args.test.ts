import { describe, expect, it } from 'vitest'
import { argsWithoutPrompt, lastingArgs } from './claude-args'

describe('lastingArgs', () => {
  it('keeps options with their values', () => {
    expect(lastingArgs(['--model', 'opus', '--permission-mode', 'plan', '--verbose'])).toEqual([
      '--model',
      'opus',
      '--permission-mode',
      'plan',
      '--verbose',
    ])
  })

  it('leaves out a prompt, also after an option with a value', () => {
    expect(lastingArgs(['--model', 'opus', 'Fix the build'])).toEqual(['--model', 'opus'])
    expect(lastingArgs(['Fix the build'])).toEqual([])
    expect(lastingArgs(['--dangerously-skip-permissions', 'Fix it'])).toEqual(['--dangerously-skip-permissions'])
  })

  it('leaves out everything after --', () => {
    expect(lastingArgs(['--model', 'opus', '--', '--not-an-option'])).toEqual(['--model', 'opus'])
  })

  it('gives an option that takes several values all of them, up to the next option', () => {
    expect(lastingArgs(['--add-dir', 'a', 'b', '--model', 'opus'])).toEqual(['--add-dir', 'a', 'b', '--model', 'opus'])
    // As Claude Code does: the prompt goes to the directories (and isn't sent).
    expect(lastingArgs(['--add-dir', 'a', 'b'])).toEqual(['--add-dir', 'a', 'b'])
  })

  it('takes a needed value as it is, even one with a dash', () => {
    expect(lastingArgs(['--append-system-prompt', '-be brief-', 'Hi'])).toEqual(['--append-system-prompt', '-be brief-'])
  })

  it('takes the value of an option with an optional one only if it is no option', () => {
    expect(lastingArgs(['--debug', 'hooks', '--model', 'opus'])).toEqual(['--debug', 'hooks', '--model', 'opus'])
    expect(lastingArgs(['--debug', '--model', 'opus'])).toEqual(['--debug', '--model', 'opus'])
  })

  it('keeps values written with =', () => {
    expect(lastingArgs(['--model=opus', '--tmux=classic', 'Hi'])).toEqual(['--model=opus', '--tmux=classic'])
  })

  it('treats --no-… options as switches', () => {
    expect(lastingArgs(['--no-chrome', 'Hi'])).toEqual(['--no-chrome'])
  })

  it('gives an unknown option the next argument unless it is an option', () => {
    expect(lastingArgs(['--brand-new', 'value', '--model', 'opus'])).toEqual(['--brand-new', 'value', '--model', 'opus'])
    expect(lastingArgs(['--brand-new', '--model', 'opus'])).toEqual(['--brand-new', '--model', 'opus'])
  })

  it('leaves out what picks the conversation, its name and its worktree', () => {
    expect(
      lastingArgs([
        '--continue',
        '-r',
        '--resume',
        '0b0e8c47-7d0e-4c9b-9a52-2b0d1e1f7a10',
        '--session-id',
        '11111111-2222-3333-4444-555555555555',
        '--fork-session',
        '--from-pr',
        '12',
        '--worktree',
        'feature',
        '-n',
        'Mein Name',
        '--model',
        'opus',
      ]),
    ).toEqual(['--model', 'opus'])
    expect(lastingArgs(['-w', '--model', 'opus'])).toEqual(['--model', 'opus'])
    expect(lastingArgs(['--resume=0b0e8c47-7d0e-4c9b-9a52-2b0d1e1f7a10', '--name=x'])).toEqual([])
  })
})

describe('argsWithoutPrompt', () => {
  it('keeps what picks the conversation and leaves out the prompt', () => {
    expect(argsWithoutPrompt(['--continue', '--model', 'opus', 'Weiter'])).toEqual(['--continue', '--model', 'opus'])
    expect(argsWithoutPrompt(['-c', '--', 'Weiter'])).toEqual(['-c'])
  })
})
