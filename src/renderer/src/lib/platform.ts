/** What differs between the Windows and the Linux app, known before the app info has loaded. */
export const isWindows = window.api.platform === 'win32'
export const isLinux = window.api.platform === 'linux'

/** Acrylic and Mica are Windows 11 backdrops; elsewhere the window is opaque and the theme colors cover it fully. */
export const supportsMaterial = isWindows

/** The shell that `shell` terminals start: PowerShell on Windows, the user's login shell elsewhere. */
export const shellLabel = isWindows ? 'PowerShell' : 'Shell'

/** Where Windows keeps secrets, and where Linux does. */
export const secretStore = isWindows ? 'Windows DPAPI' : 'Schlüsselbund des Systems'
