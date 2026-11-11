import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string

vi.mock('node:os', async (original) => ({ ...(await original<typeof import('node:os')>()), homedir: () => dir }))
vi.mock('electron', () => ({ app: { getPath: () => dir }, net: {}, safeStorage: {} }))
const decryptSecret = vi.fn<(encrypted: string) => Promise<{ plain: string; reEncrypted: string | null } | null>>()
vi.mock('../lib/secrets', () => ({ decryptSecret: (encrypted: string) => decryptSecret(encrypted), encryptSecret: vi.fn() }))

import { AccountService } from './account-service'
import type { LoginProfiles } from './login-profiles'

const profiles = { init: async () => {}, on: () => () => {}, peek: () => null, resolve: async () => {} } as unknown as LoginProfiles

let service: AccountService | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-accounts-'))
  decryptSecret.mockReset()
})

afterEach(async () => {
  service?.dispose()
  service = null
  await rm(dir, { recursive: true, force: true })
})

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
})
