import { app, safeStorage } from 'electron'

/**
 * Linux, before `ready`: Chromium only takes the Secret Service on desktops it knows (GNOME, XFCE,
 * Cinnamon, …) and on any other (sway, Hyprland, i3, MATE, LXQt, …) falls back to `basic_text`,
 * even when GNOME Keyring or KeePassXC runs there. Like VS Code the app asks for libsecret then,
 * KDE keeps KWallet. Without a Secret Service Chromium uses its fixed key, which `encryptSecret` refuses.
 */
export function selectLinuxPasswordStore(): void {
  if (process.platform !== 'linux' || app.commandLine.hasSwitch('password-store')) return
  const desktop = process.env.ORIGINAL_XDG_CURRENT_DESKTOP ?? process.env.XDG_CURRENT_DESKTOP ?? ''
  if (desktop.split(':').some((name) => name.trim().toLowerCase() === 'kde')) return
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
}

/** Chromium's Linux format for data encrypted with the key built into it, not one from the keyring. */
const LINUX_FIXED_KEY_PREFIX = 'v10'

/**
 * Encrypts secrets with the OS keystore (DPAPI on Windows, Keychain on macOS, the Secret Service
 * of GNOME Keyring or KWallet on Linux). Secrets are never written to disk in plain text — if
 * encryption is unavailable we refuse.
 */
export async function encryptSecret(plain: string): Promise<string> {
  const unavailable = () =>
    new Error(
      process.platform === 'linux'
        ? 'Kein Schlüsselbund gefunden. Tokens und API-Keys speichert die App nur verschlüsselt: Richte GNOME Keyring, KWallet oder einen anderen Secret Service ein (z. B. Paket gnome-keyring) und starte die App neu.'
        : 'Die sichere Speicherung des Betriebssystems ist nicht verfügbar.',
    )
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw unavailable()
  const encrypted = await safeStorage.encryptStringAsync(plain)
  // Linux: without a reachable keyring Chromium encrypts with a key built into it ("v10"), as good as
  // plain text, and does so even when the selected backend is libsecret or KWallet. Only data with a
  // key from the keyring ("v11" and later) is stored.
  if (process.platform === 'linux' && encrypted.subarray(0, 3).toString('latin1') === LINUX_FIXED_KEY_PREFIX) {
    throw unavailable()
  }
  return encrypted.toString('base64')
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
