import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { CommandStatus } from '@shared/types'

const run = promisify(execFile)

/**
 * The `cm` command. cm.exe ships in `<install dir>\bin`; the installer registers it, the
 * settings page can do the same. The launcher itself edits the registry (src/launcher/cm.cs).
 */
export class CommandIntegration {
  private readonly launcherPath = join(dirname(process.execPath), 'bin', 'cm.exe')

  private get available(): boolean {
    return app.isPackaged && process.platform === 'win32' && existsSync(this.launcherPath)
  }

  async status(): Promise<CommandStatus> {
    if (!this.available) return { available: false, registered: false, launcherPath: null }
    const registered = await run(this.launcherPath, ['--cm-status']).then(
      () => true,
      () => false,
    )
    return { available: true, registered, launcherPath: this.launcherPath }
  }

  async setRegistered(registered: boolean): Promise<CommandStatus> {
    if (!this.available) throw new Error('Der Befehl „cm“ gibt es nur in der installierten App.')
    await run(this.launcherPath, [registered ? '--cm-register' : '--cm-unregister'])
    return this.status()
  }
}
