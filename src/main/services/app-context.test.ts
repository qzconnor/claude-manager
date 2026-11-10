import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_PROMPT, SessionPrompt, appContextArgs, workspacePromptText } from './app-context'
import type { ClaudeCli } from './claude-cli'
import type { SettingsService } from './settings-service'
import type { WorkspacePrompt } from './workspace-service'

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

describe('SessionPrompt', () => {
  let dir: string
  const cli = (version: string | null) => ({ knownVersion: () => version }) as unknown as ClaudeCli
  const settings = (appContext: boolean) => ({ get: () => ({ claude: { appContext } }) }) as unknown as SettingsService
  const noWorkspaces = { promptsFor: () => [] }
  const WEB: WorkspacePrompt = { path: 'F:\\Webseiten', name: 'Webseiten', text: 'Nur Open-Source-Bibliotheken.' }
  const workspaces = (prompts: WorkspacePrompt[]) => ({ promptsFor: (cwd: string) => (cwd.startsWith(WEB.path) ? prompts : []) })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'app-context-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes the prompt and writes it again when it has gone missing', () => {
    const prompt = new SessionPrompt(dir, cli('2.1.319'), settings(true), noWorkspaces)
    const file = join(dir, 'claude-context.md')
    expect(prompt.args('t1', [])).toEqual([`--append-system-prompt-file=${file}`])
    expect(readFileSync(file, 'utf8')).toBe(APP_CONTEXT_PROMPT)

    rmSync(file)
    expect(prompt.args('t2', [])).toEqual([`--append-system-prompt-file=${file}`])
    expect(readFileSync(file, 'utf8')).toBe(APP_CONTEXT_PROMPT)
  })

  it('starts the session without it when the file can’t be written', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prompt = new SessionPrompt(join(dir, 'missing', 'folder'), cli('2.1.319'), settings(true), noWorkspaces)
    expect(prompt.args('t1', [])).toEqual([])
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })

  it('sends nothing when the setting is off', () => {
    const prompt = new SessionPrompt(dir, cli('2.1.319'), settings(false), noWorkspaces)
    expect(prompt.args('t1', [])).toEqual([])
    expect(existsSync(join(dir, 'claude-context.md'))).toBe(false)
  })

  it('adds the prompts of the session’s workspaces in a file of their own', () => {
    const prompt = new SessionPrompt(dir, cli('2.1.319'), settings(true), workspaces([WEB]))
    const [option] = prompt.args('t1', [], 'F:\\Webseiten\\websiteA')
    const file = option!.replace('--append-system-prompt-file=', '')
    expect(file.startsWith(join(dir, 'session-prompts'))).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text.startsWith(APP_CONTEXT_PROMPT)).toBe(true)
    expect(text).toContain('workspace "Webseiten" (F:\\Webseiten)')
    expect(text).toContain('Nur Open-Source-Bibliotheken.')

    // The same text, the same file; elsewhere only the app's context.
    expect(prompt.args('t2', [], 'F:\\Webseiten\\websiteB')).toEqual([option])
    expect(prompt.args('t3', [], 'C:\\Users\\me\\Downloads')).toEqual([`--append-system-prompt-file=${join(dir, 'claude-context.md')}`])
  })

  it('sends a workspace prompt without the app’s context when that is off', () => {
    const prompt = new SessionPrompt(dir, cli('2.1.319'), settings(false), workspaces([WEB]))
    const [option] = prompt.args('t1', [], 'F:\\Webseiten\\websiteA')
    expect(readFileSync(option!.replace('--append-system-prompt-file=', ''), 'utf8')).toBe(workspacePromptText([WEB]))
    expect(prompt.args('t2', [], 'C:\\elsewhere')).toEqual([])
  })

  it('gives way to a prompt file of the user’s own', () => {
    const prompt = new SessionPrompt(dir, cli('2.1.319'), settings(true), workspaces([WEB]))
    expect(prompt.args('t1', ['--append-system-prompt-file=mine.md'], 'F:\\Webseiten\\websiteA')).toEqual([])
  })

  it('clears out the files of an earlier run', () => {
    const before = new SessionPrompt(dir, cli('2.1.319'), settings(false), workspaces([WEB]))
    before.args('t1', [], 'F:\\Webseiten')
    const after = new SessionPrompt(dir, cli('2.1.319'), settings(false), workspaces([{ ...WEB, text: 'Anders.' }]))
    after.args('t2', [], 'F:\\Webseiten')
    expect(readdirSync(join(dir, 'session-prompts'))).toHaveLength(1)
  })
})

describe('workspacePromptText', () => {
  it('names each workspace, the outermost first', () => {
    const text = workspacePromptText([WEB_OUTER, WEB_INNER])
    expect(text.indexOf('"Webseiten"')).toBeLessThan(text.indexOf('"Kunden"'))
    expect(text).toContain('Erst das.')
    expect(text).toContain('Dann das.')
  })
})

const WEB_OUTER: WorkspacePrompt = { path: 'F:\\Webseiten', name: 'Webseiten', text: 'Erst das.' }
const WEB_INNER: WorkspacePrompt = { path: 'F:\\Webseiten\\Kunden', name: 'Kunden', text: 'Dann das.' }
