import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** How the Linux build is installed: as AppImage, from a deb or rpm package, or not at all (development). */
export type LinuxPackage = 'appimage' | 'deb' | 'rpm'

let cachedPackage: LinuxPackage | null | undefined

export function linuxPackage(): LinuxPackage | null {
  if (cachedPackage !== undefined) return cachedPackage
  cachedPackage = null
  if (process.platform !== 'linux' || !app.isPackaged) return cachedPackage
  // The AppImage runtime sets APPIMAGE to the file that was started.
  if (process.env.APPIMAGE) return (cachedPackage = 'appimage')
  // electron-builder writes the package type of deb and rpm builds next to the app (electron-updater reads it too).
  try {
    const type = readFileSync(join(process.resourcesPath, 'package-type'), 'utf8').trim()
    if (type === 'deb' || type === 'rpm') cachedPackage = type
  } catch {
    // Unpacked build (`electron-builder --dir`).
  }
  return cachedPackage
}

/**
 * The file that starts this installation, for the `cm` command and the start at login: the AppImage
 * itself (its contents are only mounted while it runs) or the app's executable.
 */
export function launchExecutable(): string {
  return (process.platform === 'linux' && process.env.APPIMAGE) || process.execPath
}

/** Variables the AppImage runtime and its AppRun script set for the app only, not for programs it starts. */
const APPIMAGE_ONLY_ENV = ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']
/** Search paths AppRun extends with folders inside the mounted AppImage. */
const APPIMAGE_PATH_ENV = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']

/**
 * Removes what the AppImage put into the environment: the shells and Claude Code sessions of the
 * terminals would otherwise look for programs and libraries inside the app's mount.
 */
export function withoutAppImageEnv(env: Record<string, string>): Record<string, string> {
  const appDir = env.APPDIR
  if (process.platform !== 'linux' || !appDir) return env
  for (const key of APPIMAGE_PATH_ENV) {
    const value = env[key]
    if (value === undefined) continue
    const kept = value.split(':').filter((entry) => entry && entry !== appDir && !entry.startsWith(`${appDir}/`))
    if (kept.length) env[key] = kept.join(':')
    else delete env[key]
  }
  for (const key of APPIMAGE_ONLY_ENV) delete env[key]
  return env
}
