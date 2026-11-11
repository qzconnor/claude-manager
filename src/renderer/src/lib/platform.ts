import type { ShellKind } from './shell-quote'

/** What differs between the Windows and the Linux app, known before the app info has loaded. */
export const isWindows = window.api.platform === 'win32'
export const isLinux = window.api.platform === 'linux'

/** Acrylic and Mica are Windows 11 backdrops; elsewhere the window is opaque and the theme colors cover it fully. */
export const supportsMaterial = isWindows

/** The shell that `shell` terminals start: PowerShell on Windows, the user's login shell elsewhere. */
export const shellLabel = isWindows ? 'PowerShell' : 'Shell'

/** How that shell reads quotes, for paths put into it. */
export const shellKind: ShellKind = isWindows ? 'powershell' : 'posix'

/** What opens a folder: the Explorer on Windows, the desktop's file manager elsewhere. */
export const fileManagerLabel = isWindows ? 'Explorer' : 'Dateimanager'

/** Where Windows keeps secrets, and where Linux does. */
export const secretStore = isWindows ? 'Windows DPAPI' : 'Schlüsselbund des Systems'
