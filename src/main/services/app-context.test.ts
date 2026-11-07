import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_PROMPT, AppContextPrompt, appContextArgs } from './app-context'
import type { ClaudeCli } from './claude-cli'
import type { SettingsService } from './settings-service'

const FILE = '/data/claude-context.md'
const OPTION = `--append-system-prompt-file=${FILE}`

describe('appContextArgs', () => {
  it('hands the file to current versions, also while the version is unknown', () => {
    expect(appContextArgs(FILE, [], '2.1.319')).toEqual([OPTION])
    expect(appContextArgs(FILE, ['--model', 'opus'], null)).toEqual([OPTION])
  })

  it('leaves out versions that only read the file with -p', () => {
    expect(appContextArgs(FILE, [], '2.1.68')).toEqual([])
    expect(appContextArgs(FILE, [], '2.1.69')).toEqual([OPTION])
  })

  it('goes with the user’s own --append-system-prompt only where Claude Code takes both', () => {
    for (const own of [['--append-system-prompt', 'Sei kurz.'], ['--append-system-prompt=Sei kurz.']]) {
      expect(appContextArgs(FILE, own, '2.1.283')).toEqual([OPTION])
      expect(appContextArgs(FILE, own, '2.1.282')).toEqual([])
      expect(appContextArgs(FILE, own, null)).toEqual([])
    }
  })

  it('gives way to a prompt file of the user’s own', () => {
    expect(appContextArgs(FILE, ['--append-system-prompt-file', 'mine.md'], '2.1.319')).toEqual([])
    expect(appContextArgs(FILE, ['--append-system-prompt-file=mine.md'], '2.1.319')).toEqual([])
  })

  it('is not fooled by other options that start alike', () => {
    expect(appContextArgs(FILE, ['--append-system-prompt-files'], null)).toEqual([OPTION])
    expect(appContextArgs(FILE, ['--append-subagent-system-prompt', 'x'], null)).toEqual([OPTION])
  })
})

describe('AppContextPrompt', () => {
  let dir: string
  const cli = (version: string | null) => ({ knownVersion: () => version }) as unknown as ClaudeCli
  const settings = (appContext: boolean) => ({ get: () => ({ claude: { appContext } }) }) as unknown as SettingsService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'app-context-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes the prompt and writes it again when it has gone missing', () => {
    const prompt = new AppContextPrompt(dir, cli('2.1.319'), settings(true))
    const file = join(dir, 'claude-context.md')
    expect(prompt.args('t1', [])).toEqual([`--append-system-prompt-file=${file}`])
    expect(readFileSync(file, 'utf8')).toBe(APP_CONTEXT_PROMPT)

    rmSync(file)
    expect(prompt.args('t2', [])).toEqual([`--append-system-prompt-file=${file}`])
    expect(readFileSync(file, 'utf8')).toBe(APP_CONTEXT_PROMPT)
  })

  it('starts the session without it when the file can’t be written', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prompt = new AppContextPrompt(join(dir, 'missing', 'folder'), cli('2.1.319'), settings(true))
    expect(prompt.args('t1', [])).toEqual([])
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })

  it('sends nothing when the setting is off', () => {
    const prompt = new AppContextPrompt(dir, cli('2.1.319'), settings(false))
    expect(prompt.args('t1', [])).toEqual([])
    expect(existsSync(join(dir, 'claude-context.md'))).toBe(false)
  })
})
