import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults'
import type { AppSettings } from '@shared/types'
import type { HookCall } from '../lib/hook-events'
import { SessionHooks } from './session-hooks'
import { SessionServer } from './session-server'
import type { SettingsService } from './settings-service'

const SESSION = '0b6c1f9e-7a7d-4a3e-9f57-2b8e1c4d5a6f'

let dir: string
let server: SessionServer
let settings: AppSettings
let received: [string, HookCall][]
let shown: string[]
let hooks: SessionHooks

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cm-hooks-'))
  server = new SessionServer()
  await server.start()
  settings = createDefaultSettings()
  received = []
  shown = []
  hooks = new SessionHooks(
    server,
    dir,
    { get: () => settings } as SettingsService,
    (id, event) => received.push([id, event]),
    (id) => shown.push(id),
  )
  hooks.init()
})

afterEach(() => {
  hooks.dispose()
  server.dispose()
  rmSync(dir, { recursive: true, force: true })
})

/** The settings file of the option `--settings=<file>`, the first of the session's. */
function settingsOf(args: string[]): { hooks: Record<string, { hooks: { url: string; headers: Record<string, string> }[] }[]> } & Record<string, unknown> {
  expect(args[0]).toMatch(/^--settings=/)
  return JSON.parse(readFileSync(args[0]!.slice('--settings='.length), 'utf8'))
}

function post(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let text = ''
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** Posts an event the way Claude Code's HTTP hook does, with the session's own token. */
async function sendHook(args: string[], body: unknown, extra: Record<string, string> = {}) {
  const handler = settingsOf(args).hooks.Stop![0]!.hooks[0]!
  return post(handler.url, JSON.stringify(body), { ...handler.headers, ...extra })
}

describe('SessionHooks', () => {
  it('gives a session a settings file whose hooks reach the app', async () => {
    const args = hooks.lastArgs('t1', [], dir)
    const answer = await sendHook(args, { hook_event_name: 'UserPromptSubmit', session_id: SESSION, prompt: 'Hallo' })
    expect(answer).toEqual({ status: 204, body: '' })
    await vi.waitFor(() => expect(received).toEqual([['t1', { sessionId: SESSION, event: { kind: 'prompt' } }]]))
  })

  it('answers events it doesn’t know or can’t read without telling them', async () => {
    const args = hooks.lastArgs('t1', [], dir)
    expect((await sendHook(args, { hook_event_name: 'FileChanged' })).status).toBe(204)
    const handler = settingsOf(args).hooks.Stop![0]!.hooks[0]!
    expect((await post(handler.url, 'not json', handler.headers)).status).toBe(204)
    expect(received).toEqual([])
  })

  it('takes no requests without the session’s token, or from pages', async () => {
    const args = hooks.lastArgs('t1', [], dir)
    const { url } = settingsOf(args).hooks.Stop![0]!.hooks[0]!
    expect((await post(url, '{}', { Authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await sendHook(args, { hook_event_name: 'Stop' }, { Origin: 'https://example.com' })).status).toBe(403)
    expect(received).toEqual([])
  })

  it('takes the token and the file back when the session ends', async () => {
    const args = hooks.lastArgs('t1', [], dir)
    const file = args[0]!.slice('--settings='.length)
    const handler = settingsOf(args).hooks.Stop![0]!.hooks[0]!
    hooks.release('t1')
    expect(existsSync(file)).toBe(false)
    expect((await post(handler.url, '{}', handler.headers)).status).toBe(401)
  })

  it('merges the user’s own --settings into its file, from a file or inline', () => {
    writeFileSync(join(dir, 'own.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'beep' }] }] } }))
    const fromFile = settingsOf(hooks.lastArgs('t1', ['--settings', 'own.json'], dir))
    expect(fromFile.model).toBe('opus')
    expect(fromFile.hooks.Stop).toHaveLength(2)
    expect(fromFile.hooks.Stop![0]).toEqual({ hooks: [{ type: 'command', command: 'beep' }] })

    const inline = settingsOf(hooks.lastArgs('t2', ['--settings={"effortLevel":"high"}'], dir))
    expect(inline.effortLevel).toBe('high')
    expect(Object.keys(inline.hooks)).toContain('PreToolUse')
  })

  it('leaves the user’s own --settings alone when it can’t read them', () => {
    expect(hooks.lastArgs('t1', ['--settings', 'missing.json'], dir)).toEqual([])
    expect(hooks.lastArgs('t1', ['--settings'], dir)).toEqual([])
  })

  it('gives no hooks when the setting is off', () => {
    settings.claude.hookState = false
    expect(hooks.lastArgs('t1', [], dir)).toEqual([])
  })

  it('gives a session the skill that takes the place of /diff, after the hooks', () => {
    const args = hooks.lastArgs('t1', [], dir)
    expect(args).toHaveLength(2)
    const folder = args[1]!.slice('--add-dir='.length)
    expect(args[1]).toBe(`--add-dir=${join(dir, 'session-commands')}`)
    const skill = readFileSync(join(folder, '.claude', 'skills', 'diff', 'SKILL.md'), 'utf8')
    expect(skill).toMatch(/^---\nname: diff\n/)
    expect(skill).toContain('\ndisable-model-invocation: true\n')
  })

  it('switches Claude Code’s own diff panel off with the skill, besides the user’s plugins', () => {
    writeFileSync(join(dir, 'own.json'), JSON.stringify({ enabledPlugins: { 'x@market': true } }))
    expect(settingsOf(hooks.lastArgs('t1', ['--settings', 'own.json'], dir)).enabledPlugins).toEqual({
      'x@market': true,
      'cc-plugin-diff@builtin': false,
    })
    settings.claude.diffCommand = false
    expect(settingsOf(hooks.lastArgs('t2', [], dir)).enabledPlugins).toBeUndefined()
  })

  it('shows the changes for /diff and stops the prompt before Claude sees it', async () => {
    const args = hooks.lastArgs('t1', [], dir)
    const answer = await sendHook(args, { hook_event_name: 'UserPromptSubmit', session_id: SESSION, prompt: '/diff' })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toMatchObject({
      decision: 'block',
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
    })
    expect(shown).toEqual(['t1'])
    expect(received).toEqual([])
  })

  it('leaves /diff to Claude Code without the setting', async () => {
    settings.claude.diffCommand = false
    const args = hooks.lastArgs('t1', [], dir)
    expect(args).toHaveLength(1)
    const answer = await sendHook(args, { hook_event_name: 'UserPromptSubmit', session_id: SESSION, prompt: '/diff' })
    expect(answer).toEqual({ status: 204, body: '' })
    await vi.waitFor(() => expect(received).toEqual([['t1', { sessionId: SESSION, event: { kind: 'prompt' } }]]))
    expect(shown).toEqual([])
  })
})
