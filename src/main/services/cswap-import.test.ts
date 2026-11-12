import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, AccountCreateInput, AccountKind, ExpectedLogin } from '@shared/types'
import type { AccountService } from './account-service'
import { CswapImport } from './cswap-import'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cm-test-'))
  // os.homedir() follows HOME (Linux) and USERPROFILE (Windows).
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('PATH', join(home, 'no-bin'))
  vi.stubEnv('XDG_DATA_HOME', '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true, maxRetries: 3 })
})

/** Puts a cswap executable into ~/.local/bin, where uv and pipx install it. */
async function installCswap(): Promise<void> {
  const bin = join(home, '.local', 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, process.platform === 'win32' ? 'cswap.exe' : 'cswap'), '')
}

async function writeSequence(data: unknown, root = join(home, '.claude-swap-backup')): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'sequence.json'), JSON.stringify(data))
}

function account(
  id: string,
  kind: AccountKind,
  identity: { email?: string; organizationUuid?: string } = {},
  expectedLogin: ExpectedLogin | null = null,
): Account {
  return {
    id,
    name: id,
    kind,
    color: '#d97757',
    configDir: `/config/${id}`,
    customConfigDir: false,
    defaultCwd: null,
    extraArgs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    hasSecret: false,
    secretHint: null,
    authState: 'ok',
    identity: {
      email: identity.email ?? null,
      displayName: null,
      organizationUuid: identity.organizationUuid ?? null,
      organizationName: null,
      organizationType: null,
      subscriptionType: null,
      rateLimitTier: null,
    },
    tokenExpiresAt: null,
    loginEndsAt: null,
    tokenSavedAt: null,
    renewable: false,
    expectedLogin,
  }
}

function fakeAccounts(accounts: Account[] = []) {
  const create = vi.fn(async (input: AccountCreateInput, _options: { expectedLogin: ExpectedLogin }) => account(`new-${input.name}`, input.kind))
  return { service: { list: () => accounts, create } as unknown as AccountService, create }
}

const SEQUENCE = {
  activeAccountNumber: 2,
  sequence: [3, 1, 2],
  accounts: {
    '1': { email: 'ada@example.com', uuid: 'u-ada', organizationUuid: 'org-ada', organizationName: "ada@example.com's Organization" },
    '2': { email: 'ADA@example.com', uuid: 'u-ada', organizationUuid: 'org-acme', organizationName: 'Acme' },
    '3': { email: 'bob@example.com', alias: '  Bob privat  ' },
    '4': { email: ' carol@example.com ', organizationUuid: 'org-carol' },
    '5': { email: '   ' },
    '6': 'broken',
    '0': { email: 'zero@example.com' },
    x: { email: 'x@example.com' },
  },
}

describe('CswapImport.status', () => {
  it('is unavailable without cswap, even when its data is there', async () => {
    await writeSequence(SEQUENCE)
    expect(await new CswapImport(fakeAccounts().service).status()).toEqual({ available: false, accounts: [] })
  })

  it('is unavailable when cswap knows no accounts', async () => {
    await installCswap()
    expect(await new CswapImport(fakeAccounts().service).status()).toEqual({ available: false, accounts: [] })
    await writeSequence({ accounts: {} })
    expect((await new CswapImport(fakeAccounts().service).status()).available).toBe(false)
    await writeSequence({ accounts: [{ email: 'a@example.com' }] })
    expect((await new CswapImport(fakeAccounts().service).status()).available).toBe(false)
  })

  it('finds cswap on the PATH', async () => {
    const bin = join(home, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, process.platform === 'win32' ? 'claude-swap.cmd' : 'claude-swap'), '')
    vi.stubEnv('PATH', bin)
    await writeSequence({ accounts: { '1': { email: 'a@example.com' } } })
    expect((await new CswapImport(fakeAccounts().service).status()).available).toBe(true)
  })

  it('lists the accounts in cswap order, skipping broken entries', async () => {
    await installCswap()
    await writeSequence(SEQUENCE)
    const { accounts } = await new CswapImport(fakeAccounts().service).status()
    expect(accounts.map((a) => a.number)).toEqual([3, 1, 2, 4])
    expect(accounts[0]).toEqual({
      number: 3,
      name: 'Bob privat',
      alias: 'Bob privat',
      email: 'bob@example.com',
      accountUuid: null,
      organizationUuid: null,
      organizationName: null,
      active: false,
      existingAccountId: null,
    })
    expect(accounts.filter((a) => a.active).map((a) => a.number)).toEqual([2])
    expect(accounts[3].email).toBe('carol@example.com')
  })

  it('adds numbers missing from the sequence in ascending order', async () => {
    await installCswap()
    await writeSequence({
      sequence: [2, 'x', 2.5],
      accounts: { '10': { email: 'j@example.com' }, '2': { email: 'b@example.com' }, '1': { email: 'a@example.com' } },
    })
    const { accounts } = await new CswapImport(fakeAccounts().service).status()
    expect(accounts.map((a) => a.number)).toEqual([2, 1, 10])
  })

  it('names accounts by alias, otherwise by email plus the organization when the email is there twice', async () => {
    await installCswap()
    await writeSequence({
      accounts: {
        ...SEQUENCE.accounts,
        '7': { email: 'dave@example.com', organizationName: 'Dave Org' },
        '8': { email: 'eve@example.com', organizationName: 'Org A' },
        '9': { email: 'eve@example.com' },
      },
    })
    const names = Object.fromEntries((await new CswapImport(fakeAccounts().service).status()).accounts.map((a) => [a.number, a.name]))
    expect(names).toEqual({
      1: 'ada@example.com (Persönlich)',
      2: 'ADA@example.com (Acme)',
      3: 'Bob privat',
      4: 'carol@example.com',
      7: 'dave@example.com',
      8: 'eve@example.com (Org A)',
      9: 'eve@example.com',
    })
  })

  it('links accounts the app already has for the same login, but not the standard account', async () => {
    await installCswap()
    await writeSequence(SEQUENCE)
    const existing = [
      account('system', 'system', { email: 'bob@example.com' }),
      account('acc-ada', 'oauth', { email: 'Ada@Example.com', organizationUuid: 'org-acme' }),
      account('acc-carol', 'oauth', {}, { email: 'CAROL@example.com', accountUuid: null, organizationUuid: 'org-carol', organizationName: null }),
      account('acc-other-org', 'token', { email: 'ada@example.com', organizationUuid: 'org-elsewhere' }),
    ]
    const { accounts } = await new CswapImport(fakeAccounts(existing).service).status()
    expect(Object.fromEntries(accounts.map((a) => [a.number, a.existingAccountId]))).toEqual({
      1: null,
      2: 'acc-ada',
      3: null,
      4: 'acc-carol',
    })
  })

  it('treats a missing organization as the same on both sides', async () => {
    await installCswap()
    await writeSequence(SEQUENCE)
    const { accounts } = await new CswapImport(fakeAccounts([account('acc-bob', 'apiKey', { email: 'bob@example.com' })]).service).status()
    expect(accounts.find((a) => a.number === 3)?.existingAccountId).toBe('acc-bob')
  })

  it('ignores an unreadable sequence file', async () => {
    await installCswap()
    await mkdir(join(home, '.claude-swap-backup'), { recursive: true })
    await writeFile(join(home, '.claude-swap-backup', 'sequence.json'), '{ broken')
    expect(await new CswapImport(fakeAccounts().service).status()).toEqual({ available: false, accounts: [] })
  })

  it.runIf(process.platform === 'linux')('reads the XDG data folder first on Linux, the legacy folder otherwise', async () => {
    await installCswap()
    await writeSequence({ accounts: { '1': { email: 'legacy@example.com' } } })
    const service = new CswapImport(fakeAccounts().service)
    expect((await service.status()).accounts.map((a) => a.email)).toEqual(['legacy@example.com'])

    await writeSequence({ accounts: { '1': { email: 'xdg-default@example.com' } } }, join(home, '.local', 'share', 'claude-swap'))
    expect((await service.status()).accounts.map((a) => a.email)).toEqual(['xdg-default@example.com'])

    await writeSequence({ accounts: { '1': { email: 'xdg@example.com' } } }, join(home, 'data', 'claude-swap'))
    vi.stubEnv('XDG_DATA_HOME', '~/data')
    expect((await service.status()).accounts.map((a) => a.email)).toEqual(['xdg@example.com'])
    // A relative XDG_DATA_HOME is invalid: the default applies.
    vi.stubEnv('XDG_DATA_HOME', 'data')
    expect((await service.status()).accounts.map((a) => a.email)).toEqual(['xdg-default@example.com'])
  })

  it.skipIf(process.platform === 'linux')('reads only the legacy folder outside Linux', async () => {
    await installCswap()
    await writeSequence({ accounts: { '1': { email: 'xdg@example.com' } } }, join(home, '.local', 'share', 'claude-swap'))
    expect((await new CswapImport(fakeAccounts().service).status()).available).toBe(false)
  })
})

describe('CswapImport.import', () => {
  it('creates a browser login for each chosen account that is new', async () => {
    await installCswap()
    await writeSequence(SEQUENCE)
    const existing = [account('acc-carol', 'oauth', { email: 'carol@example.com', organizationUuid: 'org-carol' })]
    const { service, create } = fakeAccounts(existing)
    const created = await new CswapImport(service).import({ numbers: [1, 3, 4, 99], importSettings: true })
    expect(created.map((a) => a.id)).toEqual(['new-Bob privat', 'new-ada@example.com (Persönlich)'])
    expect(create.mock.calls).toEqual([
      [
        { name: 'Bob privat', kind: 'oauth', color: '', importSettings: true },
        { expectedLogin: { email: 'bob@example.com', accountUuid: null, organizationUuid: null, organizationName: null } },
      ],
      [
        { name: 'ada@example.com (Persönlich)', kind: 'oauth', color: '', importSettings: true },
        {
          expectedLogin: {
            email: 'ada@example.com',
            accountUuid: 'u-ada',
            organizationUuid: 'org-ada',
            organizationName: "ada@example.com's Organization",
          },
        },
      ],
    ])
  })

  it('only takes over the settings when asked to with true', async () => {
    await installCswap()
    await writeSequence(SEQUENCE)
    const { service, create } = fakeAccounts()
    await new CswapImport(service).import({ numbers: [3], importSettings: 'yes' as unknown as boolean })
    expect(create.mock.calls[0][0].importSettings).toBe(false)
  })

  it('ignores numbers that are no integers', async () => {
    await installCswap()
    await writeSequence(SEQUENCE)
    const { service, create } = fakeAccounts()
    await expect(new CswapImport(service).import({ numbers: [1.5, '2'] as unknown as number[], importSettings: false })).rejects.toThrow(
      'Keiner der gewählten Accounts ist neu.',
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses when nothing chosen is new', async () => {
    await installCswap()
    await writeSequence(SEQUENCE)
    const { service, create } = fakeAccounts([account('acc-carol', 'oauth', { email: 'carol@example.com', organizationUuid: 'org-carol' })])
    await expect(new CswapImport(service).import({ numbers: [4], importSettings: false })).rejects.toThrow('Keiner der gewählten Accounts ist neu.')
    await expect(new CswapImport(service).import({ numbers: [], importSettings: false })).rejects.toThrow('Keiner')
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses without cswap', async () => {
    await writeSequence(SEQUENCE)
    const { service } = fakeAccounts()
    await expect(new CswapImport(service).import({ numbers: [1], importSettings: false })).rejects.toThrow('cswap ist nicht installiert')
  })
})
