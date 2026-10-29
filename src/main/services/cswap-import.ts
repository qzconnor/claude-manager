import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Account, CswapAccount, CswapImportInput, CswapStatus, ExpectedLogin } from '@shared/types'
import { isPersonalOrganizationName } from '@shared/utils'
import { readJson } from '../lib/json-file'
import type { AccountService } from './account-service'

/** cswap's sequence.json: its accounts by number. Only the fields the import uses. */
interface SequenceFile {
  activeAccountNumber?: unknown
  sequence?: unknown
  accounts?: unknown
}

interface SequenceAccount {
  email?: unknown
  uuid?: unknown
  organizationUuid?: unknown
  organizationName?: unknown
  alias?: unknown
}

/**
 * Takes accounts over from claude-swap (cswap): only the metadata in its sequence.json, i.e.
 * name, email and organization. cswap's stored credentials are never read. Every imported account
 * gets its own browser login, so cswap and the app never share a refresh token: it can only be
 * used once, and two copies of the same login would log each other out.
 */
export class CswapImport {
  constructor(private readonly accounts: AccountService) {}

  /** `available` only when cswap is installed and knows accounts. */
  async status(): Promise<CswapStatus> {
    if (!findExecutable()) return { available: false, accounts: [] }
    const accounts = await this.readAccounts()
    return { available: accounts.length > 0, accounts }
  }

  /** Creates a browser login account for each chosen cswap account that has none yet. */
  async import(input: CswapImportInput): Promise<Account[]> {
    const numbers = new Set(Array.isArray(input?.numbers) ? input.numbers.filter(Number.isInteger) : [])
    const status = await this.status()
    if (!status.available) throw new Error('cswap ist nicht installiert oder kennt keine Accounts.')
    const chosen = status.accounts.filter((entry) => numbers.has(entry.number) && !entry.existingAccountId)
    if (chosen.length === 0) throw new Error('Keiner der gewählten Accounts ist neu.')
    const created: Account[] = []
    for (const entry of chosen) {
      const account = await this.accounts.create(
        { name: entry.name, kind: 'oauth', color: '', importSettings: input.importSettings === true },
        { expectedLogin: expectedLoginOf(entry) },
      )
      created.push(account)
    }
    return created
  }

  private async readAccounts(): Promise<CswapAccount[]> {
    const data = await readSequence()
    if (!data || !isObject(data.accounts)) return []
    const records = data.accounts as Record<string, unknown>
    // cswap's own order first, then whatever the sequence misses.
    const order = Array.isArray(data.sequence) ? data.sequence.filter((n): n is number => Number.isInteger(n)) : []
    const numbers = [...new Set([...order, ...Object.keys(records).map(Number).sort((a, b) => a - b)])]
    const existing = this.accounts.list()
    const result: Omit<CswapAccount, 'name'>[] = []
    for (const number of numbers) {
      const record = records[String(number)]
      if (!Number.isInteger(number) || number < 1 || !isObject(record)) continue
      const entry = record as SequenceAccount
      const email = text(entry.email)
      if (!email) continue
      const account: Omit<CswapAccount, 'name' | 'existingAccountId'> = {
        number,
        alias: text(entry.alias),
        email,
        accountUuid: text(entry.uuid),
        organizationUuid: text(entry.organizationUuid),
        organizationName: text(entry.organizationName),
        active: data.activeAccountNumber === number,
      }
      result.push({ ...account, existingAccountId: findExisting(account, existing) })
    }
    return result.map((entry) => ({ ...entry, name: accountName(entry, result) }))
  }
}

/** cswap keeps its data in ~/.claude-swap-backup; on Linux in the XDG data folder. */
function backupRoots(): string[] {
  const legacy = join(homedir(), '.claude-swap-backup')
  if (process.platform !== 'linux') return [legacy]
  const xdg = (process.env.XDG_DATA_HOME ?? '').replace(/^~(?=$|\/)/, homedir())
  const data = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'share')
  // Versions before the XDG layout used the legacy folder on Linux, too.
  return [join(data, 'claude-swap'), legacy]
}

async function readSequence(): Promise<SequenceFile | null> {
  for (const root of backupRoots()) {
    const file = join(root, 'sequence.json')
    if (!existsSync(file)) continue
    const data = await readJson<SequenceFile>(file)
    return isObject(data) ? data : null
  }
  return null
}

/** cswap is installed with uv or pipx, which put it into ~/.local/bin; usually also on the PATH. */
function findExecutable(): string | null {
  const isWin = process.platform === 'win32'
  const names = isWin ? ['cswap.exe', 'claude-swap.exe', 'cswap.cmd', 'claude-swap.cmd'] : ['cswap', 'claude-swap']
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
  dirs.push(join(homedir(), '.local', 'bin'))
  if (!isWin) dirs.push('/usr/local/bin', '/opt/homebrew/bin')
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * The app account for the same person and organization: imported earlier, or a browser login
 * that already belongs to them. The standard account doesn't count, cswap switches it around.
 */
function findExisting(entry: Pick<CswapAccount, 'email' | 'organizationUuid'>, accounts: Account[]): string | null {
  const sameLogin = (email: string | null, organizationUuid: string | null) =>
    !!email && email.toLowerCase() === entry.email.toLowerCase() && (organizationUuid ?? '') === (entry.organizationUuid ?? '')
  const match = accounts.find(
    (account) =>
      account.kind !== 'system' &&
      (sameLogin(account.expectedLogin?.email ?? null, account.expectedLogin?.organizationUuid ?? null) ||
        sameLogin(account.identity.email, account.identity.organizationUuid)),
  )
  return match?.id ?? null
}

/** cswap's alias; otherwise the email, plus the organization when the email is there twice. */
function accountName(entry: Omit<CswapAccount, 'name'>, all: Omit<CswapAccount, 'name'>[]): string {
  if (entry.alias) return entry.alias
  const shared = all.some((other) => other !== entry && other.email.toLowerCase() === entry.email.toLowerCase())
  const organization = entry.organizationName
  if (!shared || !organization) return entry.email
  return `${entry.email} (${isPersonalOrganizationName(organization) ? 'Persönlich' : organization})`
}

function expectedLoginOf(entry: CswapAccount): ExpectedLogin {
  return {
    email: entry.email,
    accountUuid: entry.accountUuid,
    organizationUuid: entry.organizationUuid,
    organizationName: entry.organizationName,
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
