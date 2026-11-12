import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountKind } from '@shared/types'

vi.mock('electron', () => ({ app: { getPath: () => '', getVersion: () => '0.0.0' }, net: { fetch: vi.fn() } }))
const renewOAuthLogin = vi.hoisted(() => vi.fn())
vi.mock('./oauth-renewal', () => ({ renewOAuthLogin }))

import type { AccountCredentials } from './account-service'
import { UsageService } from './usage-service'

function setup(kind: AccountKind, accessToken: string | null = 'sk-ant-oat01-token') {
  const credentials = {
    kind,
    accessToken,
    accessTokenExpiresAt: Date.now() + 60_000,
    secret: null,
    paths: { configDir: 'C:/profile', credentialsFile: 'C:/profile/.credentials.json' },
    accountUuid: null,
    loginKey: null,
  } as unknown as AccountCredentials
  const accounts = { credentials: () => credentials, refresh: vi.fn(), list: () => [{ id: 'a' }], on: () => undefined }
  const service = new UsageService(accounts as never, {} as never, {} as never, '', 'claude-manager/1.0')
  const refresh = vi.spyOn(service, 'refresh').mockResolvedValue([])
  return { service, accounts, refresh }
}

afterEach(() => renewOAuthLogin.mockReset())

describe('UsageService.renewLogin', () => {
  it('renews also a token that still works, shows its expiry and asks for the usage with it', async () => {
    const { service, accounts, refresh } = setup('oauth')
    renewOAuthLogin.mockResolvedValue('renewed')

    expect(await service.renewLogin('a')).toBe('renewed')
    expect(renewOAuthLogin).toHaveBeenCalledWith('C:/profile', 'C:/profile/.credentials.json', 'claude-manager/1.0', { force: true })
    expect(accounts.refresh).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledWith('a')
  })

  it.each(['rejected', 'busy', 'failed'] as const)('tells when it %s, and asks for no usage', async (result) => {
    const { service, accounts, refresh } = setup('system')
    renewOAuthLogin.mockResolvedValue(result)

    expect(await service.renewLogin('a')).toBe(result)
    // A refused login shows as dead.
    expect(accounts.refresh).toHaveBeenCalledOnce()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('renews only browser logins that are signed in', async () => {
    await expect(setup('token').service.renewLogin('a')).rejects.toThrow('Nur Browser-Logins')
    await expect(setup('apiKey').service.renewLogin('a')).rejects.toThrow('Nur Browser-Logins')
    await expect(setup('oauth', null).service.renewLogin('a')).rejects.toThrow('nicht angemeldet')
    expect(renewOAuthLogin).not.toHaveBeenCalled()
  })
})
