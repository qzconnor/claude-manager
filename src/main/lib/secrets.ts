import { safeStorage } from 'electron'

/**
 * Encrypts secrets with the OS keystore (DPAPI on Windows, Keychain on macOS).
 * Secrets are never written to disk in plain text — if encryption is unavailable we refuse.
 */
export async function encryptSecret(plain: string): Promise<string> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error('Die sichere Speicherung des Betriebssystems ist nicht verfügbar.')
  }
  return (await safeStorage.encryptStringAsync(plain)).toString('base64')
}

export interface DecryptedSecret {
  plain: string
  /** Set when the OS key changed: this should be stored instead of the old value. */
  reEncrypted: string | null
}

/** Also reads secrets stored with the former synchronous API. `null` when it can't be decrypted. */
export async function decryptSecret(encrypted: string): Promise<DecryptedSecret | null> {
  let decrypted: Electron.DecryptStringAsyncReturnValue
  try {
    decrypted = await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))
  } catch {
    return null
  }
  let reEncrypted: string | null = null
  if (decrypted.shouldReEncrypt) {
    try {
      reEncrypted = await encryptSecret(decrypted.result)
    } catch {
      // The old value still decrypts; it is kept.
    }
  }
  return { plain: decrypted.result, reEncrypted }
}
