import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { app } from 'electron'

/**
 * Where a session starts when neither the tab, its account nor the settings name a folder: the
 * Downloads folder (also where Windows moved it). Not the home folder: Claude Code asks for trust
 * there with every session, and a yes saved there would cover every folder below it.
 */
export function fallbackSessionFolder(): string {
  try {
    const downloads = app.getPath('downloads')
    if (existsSync(downloads)) return downloads
  } catch {
    // No Downloads folder known to the system.
  }
  return homedir()
}
