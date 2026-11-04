import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import { launchExecutable, linuxPackage } from './linux'

/** The system starts the app with this switch at login (setting `launchAtLogin`). */
export const AUTOSTART_ARG = '--autostart'

/**
 * Registers or removes the start at login. Windows: a value under HKCU\Software\Microsoft\Windows\
 * CurrentVersion\Run, named after the AppUserModelId (build/installer.nsh removes it on uninstall).
 * Linux: an entry in ~/.config/autostart (XDG Autostart), which every desktop environment reads.
 * `onlyIfChanged` leaves a matching entry alone, so a start switched off in the Task Manager stays off.
 */
export function setLaunchAtLogin(enabled: boolean, onlyIfChanged = false): void {
  // A development build would register electron.exe without the app.
  if (!app.isPackaged) return
  if (process.platform === 'linux') return setLinuxAutostart(enabled, onlyIfChanged)
  if (process.platform !== 'win32') return
  const args = [AUTOSTART_ARG]
  if (onlyIfChanged && app.getLoginItemSettings({ args }).openAtLogin === enabled) return
  app.setLoginItemSettings({ openAtLogin: enabled, args })
}

function autostartFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const configDir = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config')
  return join(configDir, 'autostart', 'claude-manager.desktop')
}

/** Quotes a path for the Exec key of a desktop entry (Desktop Entry Specification). */
function quoteExec(path: string): string {
  return `"${path.replace(/["`$\\]/g, '\\$&').replaceAll('%', '%%')}"`
}

/**
 * The AppImage carries its path in the entry, which the start keeps up to date after a move or an
 * update with a new file name. Otherwise `onlyIfChanged` keeps the entry as it is, e.g. switched off
 * in the desktop's settings for autostart programs.
 */
function setLinuxAutostart(enabled: boolean, onlyIfChanged: boolean): void {
  if (!linuxPackage()) return
  const file = autostartFile()
  try {
    if (!enabled) {
      rmSync(file, { force: true })
      return
    }
    const entry = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Claude Manager',
      'Comment=Claude-Code-Terminals, Accounts, Sessions und Usage',
      `Exec=${quoteExec(launchExecutable())} ${AUTOSTART_ARG}`,
      'Icon=claude-manager',
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n')
    const exec = entry.split('\n').find((line) => line.startsWith('Exec='))
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null
    if (current === entry || (onlyIfChanged && exec && current?.split('\n').includes(exec))) return
    mkdirSync(join(file, '..'), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, entry)
    renameSync(temp, file)
  } catch (error) {
    console.warn('[autostart] the entry could not be changed', error)
  }
}
