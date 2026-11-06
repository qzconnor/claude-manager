import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptSecret, encryptSecret, selectLinuxPasswordStore } from './secrets'

const electron = vi.hoisted(() => ({
  app: {
    commandLine: {
      hasSwitch: vi.fn<(name: string) => boolean>(),
      appendSwitch: vi.fn<(name: string, value?: string) => void>(),
    },
  },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn<() => Promise<boolean>>(),
    encryptStringAsync: vi.fn<(plain: string) => Promise<Buffer>>(),
    decryptStringAsync: vi.fn<(encrypted: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>>(),
  },
}))
vi.mock('electron', () => electron)

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...platform, value })
}

/** Encrypts like Chromium: a version prefix in front of the ciphertext. */
function encrypted(prefix: string, plain: string): Buffer {
  return Buffer.concat([Buffer.from(prefix, 'latin1'), Buffer.from(plain, 'utf8')])
}

beforeEach(() => {
  vi.resetAllMocks()
  electron.app.commandLine.hasSwitch.mockReturnValue(false)
  electron.safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(true)
  electron.safeStorage.encryptStringAsync.mockImplementation(async (plain) => encrypted('v11', plain))
  vi.stubEnv('ORIGINAL_XDG_CURRENT_DESKTOP', undefined)
  vi.stubEnv('XDG_CURRENT_DESKTOP', undefined)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
})

describe('selectLinuxPasswordStore', () => {
  it.each(['sway', 'Hyprland', 'MATE', 'GNOME', 'ubuntu:GNOME', ''])('asks for libsecret on %j', (desktop) => {
    setPlatform('linux')
    vi.stubEnv('XDG_CURRENT_DESKTOP', desktop)
    selectLinuxPasswordStore()
    expect(electron.app.commandLine.appendSwitch).toHaveBeenCalledWith('password-store', 'gnome-libsecret')
  })

  it.each(['KDE', 'kde', 'X-Generic: KDE '])('keeps KWallet on %j', (desktop) => {
    setPlatform('linux')
    vi.stubEnv('XDG_CURRENT_DESKTOP', desktop)
    selectLinuxPasswordStore()
    expect(electron.app.commandLine.appendSwitch).not.toHaveBeenCalled()
  })

  it('reads the desktop Electron replaced from ORIGINAL_XDG_CURRENT_DESKTOP', () => {
    setPlatform('linux')
    vi.stubEnv('ORIGINAL_XDG_CURRENT_DESKTOP', 'KDE')
    vi.stubEnv('XDG_CURRENT_DESKTOP', 'Unity')
    selectLinuxPasswordStore()
    expect(electron.app.commandLine.appendSwitch).not.toHaveBeenCalled()
  })

  it('respects a password store chosen on the command line', () => {
    setPlatform('linux')
    electron.app.commandLine.hasSwitch.mockImplementation((name) => name === 'password-store')
    selectLinuxPasswordStore()
    expect(electron.app.commandLine.appendSwitch).not.toHaveBeenCalled()
  })

  it.each(['win32', 'darwin'] as const)('does nothing on %s', (value) => {
    setPlatform(value)
    selectLinuxPasswordStore()
    expect(electron.app.commandLine.appendSwitch).not.toHaveBeenCalled()
  })
})

describe('encryptSecret', () => {
  it('returns the encrypted value as base64', async () => {
    setPlatform('linux')
    const result = await encryptSecret('sk-ant-secret')
    expect(Buffer.from(result, 'base64').equals(encrypted('v11', 'sk-ant-secret'))).toBe(true)
  })

  it('refuses when the OS cannot encrypt', async () => {
    setPlatform('win32')
    electron.safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false)
    await expect(encryptSecret('secret')).rejects.toThrow('nicht verfügbar')
    expect(electron.safeStorage.encryptStringAsync).not.toHaveBeenCalled()
  })

  it('refuses the fixed key Chromium uses on Linux without a keyring', async () => {
    setPlatform('linux')
    electron.safeStorage.encryptStringAsync.mockResolvedValue(encrypted('v10', 'secret'))
    await expect(encryptSecret('secret')).rejects.toThrow('Schlüsselbund')
  })

  it('checks for the fixed key only on Linux', async () => {
    setPlatform('win32')
    electron.safeStorage.encryptStringAsync.mockResolvedValue(encrypted('v10', 'secret'))
    await expect(encryptSecret('secret')).resolves.toBe(encrypted('v10', 'secret').toString('base64'))
  })
})

describe('decryptSecret', () => {
  it('decrypts a base64 value', async () => {
    electron.safeStorage.decryptStringAsync.mockResolvedValue({ result: 'secret', shouldReEncrypt: false })
    expect(await decryptSecret(Buffer.from('cipher').toString('base64'))).toEqual({ plain: 'secret', reEncrypted: null })
    expect(electron.safeStorage.decryptStringAsync.mock.calls[0][0].toString()).toBe('cipher')
  })

  it('returns null when the value cannot be decrypted', async () => {
    electron.safeStorage.decryptStringAsync.mockRejectedValue(new Error('Error while decrypting the ciphertext'))
    expect(await decryptSecret('AAAA')).toBeNull()
  })

  it('encrypts again with the new key when the OS asks for it', async () => {
    setPlatform('linux')
    electron.safeStorage.decryptStringAsync.mockResolvedValue({ result: 'secret', shouldReEncrypt: true })
    expect(await decryptSecret('AAAA')).toEqual({ plain: 'secret', reEncrypted: encrypted('v11', 'secret').toString('base64') })
  })

  it('keeps the old value when encrypting again fails', async () => {
    setPlatform('linux')
    electron.safeStorage.decryptStringAsync.mockResolvedValue({ result: 'secret', shouldReEncrypt: true })
    electron.safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false)
    expect(await decryptSecret('AAAA')).toEqual({ plain: 'secret', reEncrypted: null })
  })
})
