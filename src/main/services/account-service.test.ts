import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_COLORS } from '@shared/defaults'

let dir: string

vi.mock('node:os', async (original) => ({ ...(await original<typeof import('node:os')>()), homedir: () => dir }))
vi.mock('electron', () => ({ app: { getPath: () => dir }, net: {}, safeStorage: {} }))
const decryptSecret = vi.fn<(encrypted: string) => Promise<{ plain: string; reEncrypted: string | null } | null>>()
const encryptSecret = vi.fn<(plain: string) => Promise<string>>()
vi.mock('../lib/secrets', () => ({
  decryptSecret: (encrypted: string) => decryptSecret(encrypted),
  encryptSecret: (plain: string) => encryptSecret(plain),
}))

import { AccountService } from './account-service'
import { AUTH_OVERRIDE_ENV } from './claude-cli'
import type { LoginProfiles } from './login-profiles'

const profiles = {
  init: async () => {},
  on: () => () => {},
  peek: () => null,
  resolve: async () => {},
  forget: () => {},
} as unknown as LoginProfiles

let service: AccountService | null = null

/** What the fake OS encryption makes of a secret: nothing of the plain text is left to read. */
const encrypted = (plain: string) => `enc:${Buffer.from(plain).toString('base64')}`

const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz'
const API_KEY = 'sk-ant-api03-0123456789zyxwvutsrqponmlk'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-accounts-'))
  // The default account follows CLAUDE_CONFIG_DIR, which a Claude Code session running the tests sets.
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
  decryptSecret.mockReset()
  decryptSecret.mockImplementation(async (value) =>
    value.startsWith('enc:') ? { plain: Buffer.from(value.slice(4), 'base64').toString(), reEncrypted: null } : null,
  )
  encryptSecret.mockReset()
  encryptSecret.mockImplementation(async (plain) => encrypted(plain))
})

afterEach(async () => {
  service?.dispose()
  service = null
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

const accountsFile = () => join(dir, 'accounts.json')

/** An account as the app stores it in accounts.json. */
function stored(id: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Name ${id}`,
    kind,
    color: '#112233',
    configDir: null,
    defaultCwd: null,
    extraArgs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    secret: null,
    secretHint: null,
    expectedLogin: null,
    ...extra,
  }
}

async function writeAccounts(accounts: unknown[]): Promise<void> {
  await writeFile(accountsFile(), JSON.stringify({ version: 1, accounts }))
}

async function readAccounts(): Promise<{ version: number; accounts: Record<string, unknown>[] }> {
  return JSON.parse(await readFile(accountsFile(), 'utf8')) as { version: number; accounts: Record<string, unknown>[] }
}

/** A started service, as after a (re)start of the app; the one before is stopped. */
async function start(): Promise<AccountService> {
  service?.dispose()
  service = new AccountService(dir, profiles)
  await service.init()
  return service
}

describe('AccountService secrets', () => {
  it('tries a secret that did not decrypt at the start again, less and less often', async () => {
    const token = { id: 'tok', name: 'Token', kind: 'token', color: '#000000', configDir: null, defaultCwd: null, extraArgs: [], createdAt: '', secret: 'enc', secretHint: null, expectedLogin: null }
    await writeFile(join(dir, 'accounts.json'), JSON.stringify({ accounts: [token] }))
    // The keyring is still locked at the start.
    decryptSecret.mockResolvedValue(null)
    service = new AccountService(dir, profiles)
    await service.init()
    expect(service.get('tok').authState).toBe('missing')

    const start = Date.now()
    await service.retrySecrets(start)
    expect(decryptSecret).toHaveBeenCalledTimes(1)
    await service.retrySecrets(start + 31_000)
    expect(decryptSecret).toHaveBeenCalledTimes(2)
    // Waits longer after another miss.
    await service.retrySecrets(start + 62_000)
    expect(decryptSecret).toHaveBeenCalledTimes(2)

    decryptSecret.mockResolvedValue({ plain: 'sk-ant-oat01-secret', reEncrypted: null })
    const changed = vi.fn()
    service.on('changed', changed)
    await service.retrySecrets(start + 200_000)
    expect(service.get('tok').authState).toBe('ok')
    expect(changed).toHaveBeenCalled()
    expect(service.launchEnv('tok').set.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-secret')
  })

  it('saves a secret anew that the system wants encrypted again', async () => {
    await writeAccounts([stored('system', 'system'), stored('tok', 'token', { secret: 'old-format' })])
    decryptSecret.mockImplementation(async (value) => (value === 'old-format' ? { plain: TOKEN, reEncrypted: 'new-format' } : null))
    const accounts = await start()
    expect(accounts.get('tok').authState).toBe('ok')
    expect((await readAccounts()).accounts.find((a) => a.id === 'tok')?.secret).toBe('new-format')
  })
})

describe('AccountService loading', () => {
  it('starts with the default account and saves it when there is no accounts file', async () => {
    const accounts = await start()
    expect(accounts.list()).toEqual([
      expect.objectContaining({ id: 'system', kind: 'system', name: 'Standard (~/.claude)', configDir: join(dir, '.claude') }),
    ])
    const saved = await readAccounts()
    expect(saved.version).toBe(1)
    expect(saved.accounts.map((a) => a.id)).toEqual(['system'])
  })

  it('keeps the stored accounts in their order and drops entries that are not accounts', async () => {
    await writeAccounts([
      stored('system', 'system'),
      stored('web', 'oauth'),
      stored('odd', 'password'),
      { ...stored('noargs', 'oauth'), extraArgs: '--verbose' },
      { ...stored('nocolor', 'oauth'), color: null },
      { ...stored('noname', 'oauth'), name: 42 },
      null,
      'text',
      stored('tok', 'token'),
    ])
    const accounts = await start()
    expect(accounts.list().map((a) => a.id)).toEqual(['system', 'web', 'tok'])
    expect(accounts.get('web')).toMatchObject({ name: 'Name web', kind: 'oauth', color: '#112233', configDir: join(dir, 'profiles', 'web') })
  })

  it('puts the default account in front of the accounts of a file without it', async () => {
    await writeAccounts([stored('web', 'oauth')])
    const accounts = await start()
    expect(accounts.list().map((a) => a.id)).toEqual(['system', 'web'])
    expect((await readAccounts()).accounts.map((a) => a.id)).toEqual(['system', 'web'])
  })

  it('starts with the default account when the file holds no list of accounts', async () => {
    await writeFile(accountsFile(), JSON.stringify({ version: 1, accounts: { web: stored('web', 'oauth') } }))
    expect((await start()).list().map((a) => a.id)).toEqual(['system'])
  })

  it('loads the last good version of a broken file and keeps the broken one aside', async () => {
    await writeFile(`${accountsFile()}.bak`, JSON.stringify({ version: 1, accounts: [stored('system', 'system'), stored('web', 'oauth')] }))
    // E.g. cut off by a power failure.
    await writeFile(accountsFile(), '{ "version": 1, "accounts": [')
    const accounts = await start()
    expect(accounts.list().map((a) => a.id)).toEqual(['system', 'web'])

    const aside = (await readdir(dir)).filter((name) => name.startsWith('accounts.json.broken-'))
    expect(aside).toHaveLength(1)
    expect(await readFile(join(dir, aside[0]!), 'utf8')).toBe('{ "version": 1, "accounts": [')
    expect((await readAccounts()).accounts.map((a) => a.id)).toEqual(['system', 'web'])
  })

  it('starts with the default account when a broken file has no backup, without losing the broken file', async () => {
    await writeFile(accountsFile(), '')
    const accounts = await start()
    expect(accounts.list().map((a) => a.id)).toEqual(['system'])
    expect((await readdir(dir)).filter((name) => name.startsWith('accounts.json.broken-'))).toHaveLength(1)
    expect((await readAccounts()).accounts.map((a) => a.id)).toEqual(['system'])
  })
})

describe('AccountService persistence', () => {
  it('saves a new account and finds it again after a restart', async () => {
    let accounts = await start()
    const created = await accounts.create(
      { name: '  Work  ', kind: 'oauth', color: '#123456', defaultCwd: '  C:\\work  ', extraArgs: [' --verbose ', '', '   '] },
      { expectedLogin: { email: ' me@example.com ', accountUuid: 'uuid-1', organizationUuid: '', organizationName: null } },
    )
    expect(created).toMatchObject({
      name: 'Work',
      kind: 'oauth',
      color: '#123456',
      configDir: join(dir, 'profiles', created.id),
      customConfigDir: false,
      defaultCwd: 'C:\\work',
      extraArgs: ['--verbose'],
      hasSecret: false,
      authState: 'missing',
      expectedLogin: { email: 'me@example.com', accountUuid: 'uuid-1', organizationUuid: null, organizationName: null },
    })
    expect(existsSync(join(dir, 'profiles', created.id))).toBe(true)

    accounts = await start()
    expect(accounts.list().map((a) => a.id)).toEqual(['system', created.id])
    expect(accounts.get(created.id)).toEqual(created)
  })

  it('stores a token only encrypted and has it again after a restart', async () => {
    let accounts = await start()
    const created = await accounts.create({ name: 'CI', kind: 'token', color: '', secret: `  ${TOKEN}  ` })
    expect(encryptSecret).toHaveBeenCalledWith(TOKEN)
    expect(created).toMatchObject({ color: ACCOUNT_COLORS[1], hasSecret: true, secretHint: 'sk-ant-oat01-…wxyz', authState: 'ok' })

    expect(await readFile(accountsFile(), 'utf8')).not.toContain('abcdefghijklmnop')
    expect((await readAccounts()).accounts.find((a) => a.id === created.id)).toMatchObject({
      secret: encrypted(TOKEN),
      secretHint: 'sk-ant-oat01-…wxyz',
    })

    accounts = await start()
    expect(accounts.get(created.id).authState).toBe('ok')
    expect(accounts.launchEnv(created.id).set.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN)
  })

  it('saves nothing when a new token is refused, neither the account nor its folder', async () => {
    const accounts = await start()
    const before = await readFile(accountsFile(), 'utf8')
    await expect(accounts.create({ name: 'CI', kind: 'token', color: '', secret: 'ghp_not-a-claude-token' })).rejects.toThrow(
      'Der Token muss mit „sk-ant-“ beginnen',
    )
    encryptSecret.mockRejectedValue(new Error('Die sichere Speicherung des Betriebssystems ist nicht verfügbar.'))
    await expect(accounts.create({ name: 'CI', kind: 'apiKey', color: '', secret: API_KEY })).rejects.toThrow('nicht verfügbar')

    expect(accounts.list().map((a) => a.id)).toEqual(['system'])
    expect(await readFile(accountsFile(), 'utf8')).toBe(before)
    expect(existsSync(join(dir, 'profiles'))).toBe(false)
  })

  it('replaces the file atomically and keeps the version before as a backup', async () => {
    const accounts = await start()
    const before = await readFile(accountsFile(), 'utf8')
    await accounts.create({ name: 'Second', kind: 'oauth', color: '#123456' })
    expect(await readFile(`${accountsFile()}.bak`, 'utf8')).toBe(before)
    expect((await readAccounts()).accounts.map((a) => a.name)).toEqual(['Standard (~/.claude)', 'Second'])
    // No temporary file is left behind next to it.
    expect((await readdir(dir)).sort()).toEqual(['accounts.json', 'accounts.json.bak', 'profiles'])
  })

  it('saves changed and removed accounts so that a restart has them the same way', async () => {
    let accounts = await start()
    const web = await accounts.create({ name: 'Web', kind: 'oauth', color: '#123456', defaultCwd: 'C:\\old', extraArgs: ['--a'] })
    const ci = await accounts.create({ name: 'CI', kind: 'token', color: '#654321', secret: TOKEN })

    await accounts.update(web.id, { name: ' Renamed ', color: 'red', defaultCwd: null, extraArgs: [' --b ', ''] })
    await accounts.update(ci.id, { secret: API_KEY.replace('api03', 'oat01') })
    accounts = await start()
    expect(accounts.get(web.id)).toMatchObject({ name: 'Renamed', color: '#123456', defaultCwd: null, extraArgs: ['--b'] })
    expect(accounts.get(ci.id).secretHint).toBe('sk-ant-oat01-…nmlk')
    expect(accounts.launchEnv(ci.id).set.CLAUDE_CODE_OAUTH_TOKEN).toBe(API_KEY.replace('api03', 'oat01'))

    await accounts.remove(ci.id, { deleteConfigDir: true })
    expect(existsSync(join(dir, 'profiles', ci.id))).toBe(false)
    accounts = await start()
    expect(accounts.list().map((a) => a.id)).toEqual(['system', web.id])
    expect(() => accounts.get(ci.id)).toThrow(`Konto „${ci.id}“ existiert nicht.`)
  })

  it('leaves an account and the file untouched when a change is refused', async () => {
    await writeAccounts([stored('system', 'system'), stored('web', 'oauth'), stored('tok', 'token', { secret: encrypted(TOKEN) })])
    const accounts = await start()
    const before = await readFile(accountsFile(), 'utf8')

    await expect(accounts.update('tok', { name: 'New', secret: 'not-a-token' })).rejects.toThrow('Das Secret muss mit „sk-ant-“ beginnen.')
    await expect(accounts.update('web', { name: 'New', secret: TOKEN })).rejects.toThrow('Nur Token- und API-Key-Konten speichern ein Secret.')
    await expect(accounts.update('web', { name: '   ' })).rejects.toThrow('Bitte gib einen Namen an.')

    expect(await readFile(accountsFile(), 'utf8')).toBe(before)
    // Nothing of a refused change shows up later either, neither after the next refresh nor with the next save.
    accounts.refresh()
    expect(accounts.get('tok').name).toBe('Name tok')
    expect(accounts.get('web').name).toBe('Name web')
    expect(accounts.launchEnv('tok').set.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN)
    await accounts.update('web', { color: '#abcdef' })
    expect((await readAccounts()).accounts.map((a) => a.name)).toEqual(['Name system', 'Name web', 'Name tok'])
  })
})

describe('AccountService launchEnv', () => {
  const custom = () => join(dir, 'custom-claude')

  beforeEach(async () => {
    await writeAccounts([
      stored('system', 'system'),
      stored('web', 'oauth'),
      stored('own', 'oauth', { configDir: custom() }),
      stored('tok', 'token', { secret: encrypted(TOKEN) }),
      stored('key', 'apiKey', { secret: encrypted(API_KEY) }),
      stored('locked', 'token', { secret: 'did-not-decrypt' }),
      stored('empty', 'apiKey'),
    ])
  })

  it('starts the default account with the environment as it is', async () => {
    const accounts = await start()
    expect(accounts.launchEnv('system')).toEqual({ set: {}, unset: [] })
  })

  it('gives a browser account its own config folder and removes credentials from the environment', async () => {
    const accounts = await start()
    expect(accounts.launchEnv('web')).toEqual({ set: { CLAUDE_CONFIG_DIR: join(dir, 'profiles', 'web') }, unset: [...AUTH_OVERRIDE_ENV] })
    expect(accounts.launchEnv('own').set).toEqual({ CLAUDE_CONFIG_DIR: custom() })
    expect(accounts.launchEnv('web').unset).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']))
  })

  it('passes a setup token as CLAUDE_CODE_OAUTH_TOKEN and an API key as ANTHROPIC_API_KEY', async () => {
    const accounts = await start()
    expect(accounts.launchEnv('tok')).toEqual({
      set: { CLAUDE_CONFIG_DIR: join(dir, 'profiles', 'tok'), CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      unset: [...AUTH_OVERRIDE_ENV],
    })
    expect(accounts.launchEnv('key')).toEqual({
      set: { CLAUDE_CONFIG_DIR: join(dir, 'profiles', 'key'), ANTHROPIC_API_KEY: API_KEY },
      unset: [...AUTH_OVERRIDE_ENV],
    })
  })

  it('runs a folder with the token or API key of another account, but not with its browser login', async () => {
    const accounts = await start()
    expect(accounts.launchEnv('web', 'tok').set).toEqual({ CLAUDE_CONFIG_DIR: join(dir, 'profiles', 'web'), CLAUDE_CODE_OAUTH_TOKEN: TOKEN })
    // ~/.claude stays the folder of the default account, so no CLAUDE_CONFIG_DIR.
    expect(accounts.launchEnv('system', 'key')).toEqual({ set: { ANTHROPIC_API_KEY: API_KEY }, unset: [...AUTH_OVERRIDE_ENV] })

    expect(() => accounts.launchEnv('tok', 'web')).toThrow('„Name web“ ist per Browser angemeldet. Dieser Login funktioniert nur im eigenen Ordner.')
    expect(() => accounts.launchEnv('web', 'system')).toThrow('ist per Browser angemeldet')
  })

  it('refuses to start a token or API key account without a usable secret', async () => {
    const accounts = await start()
    expect(() => accounts.launchEnv('locked')).toThrow('Für „Name locked“ ist kein gültiges Secret gespeichert. Bitte neu eintragen.')
    expect(() => accounts.launchEnv('web', 'empty')).toThrow('Für „Name empty“ ist kein gültiges Secret gespeichert.')
    expect(() => accounts.launchEnv('gone')).toThrow('Konto „gone“ existiert nicht.')
    expect(() => accounts.launchEnv('web', 'gone')).toThrow('Konto „gone“ existiert nicht.')
  })
})
