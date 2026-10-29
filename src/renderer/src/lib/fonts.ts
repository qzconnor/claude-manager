let cache: Promise<string[]> | null = null

/** Installed font families; listed once per app session (PowerShell call in the main process). */
export function listInstalledFonts(): Promise<string[]> {
  cache ??= window.api.app.listFonts().catch(() => {
    cache = null
    return []
  })
  return cache
}
