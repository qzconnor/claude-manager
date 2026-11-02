import { app } from 'electron'

/** Windows starts the app with this switch at login (setting `launchAtLogin`). */
export const AUTOSTART_ARG = '--autostart'

/**
 * Registers or removes the start at login: a value under HKCU\Software\Microsoft\Windows\
 * CurrentVersion\Run, named after the AppUserModelId (build/installer.nsh removes it on uninstall).
 * `onlyIfChanged` leaves a matching entry alone, so a start switched off in the Task Manager stays off.
 */
export function setLaunchAtLogin(enabled: boolean, onlyIfChanged = false): void {
  // A development build would register electron.exe without the app.
  if (process.platform !== 'win32' || !app.isPackaged) return
  const args = [AUTOSTART_ARG]
  if (onlyIfChanged && app.getLoginItemSettings({ args }).openAtLogin === enabled) return
  app.setLoginItemSettings({ openAtLogin: enabled, args })
}
