import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { CommandStatus } from '@shared/types'
import { readJson, writeJsonAtomic } from '../lib/json-file'
import { launchExecutable, linuxPackage } from '../lib/linux'
import { launcherScript, launcherTarget } from './linux-launcher'

const run = promisify(execFile)

/**
 * The `cm` command. On Windows cm.exe ships in `<install dir>\bin`; the installer registers it,
 * the settings page can do the same. The launcher itself edits the registry (src/launcher/cm.cs).
 * On Linux the app writes a small script to ~/.local/bin (src/main/cli/linux-launcher.ts): on the
 * first start, like the Windows installer, and afterwards only when asked to on the settings page.
 */
export class CommandIntegration {
  private readonly windowsLauncher = join(dirname(process.execPath), 'bin', 'cm.exe')
  private readonly linuxLauncher = join(homedir(), '.local', 'bin', 'cm')
  /** Remembers that the first start registered the command, so it isn't registered again after an unregister. */
  private readonly stateFile: string

  constructor(userDataDir: string) {
    this.stateFile = join(userDataDir, 'cm-command.json')
  }

  private get available(): boolean {
    if (!app.isPackaged) return false
    if (process.platform === 'win32') return existsSync(this.windowsLauncher)
    return process.platform === 'linux' && linuxPackage() !== null
  }

  /** Linux: registers the command on the first start and keeps the script (and the app's path in it) up to date. */
  async init(): Promise<void> {
    if (process.platform !== 'linux' || !this.available) return
    try {
      const script = await readFile(this.linuxLauncher, 'utf8').catch(() => null)
      if (script !== null && launcherTarget(script) !== null) {
        // The AppImage was moved or renamed by an update, or the script of an older version.
        if (script !== launcherScript(launchExecutable())) await this.writeLinuxLauncher()
        return
      }
      const state = await readJson<{ registeredOnce?: boolean }>(this.stateFile)
      if (state?.registeredOnce) return
      if (!existsSync(this.linuxLauncher)) await this.writeLinuxLauncher()
      await writeJsonAtomic(this.stateFile, { registeredOnce: true })
    } catch (error) {
      console.warn('[cm] the command could not be set up', error)
    }
  }

  async status(): Promise<CommandStatus> {
    if (!this.available) return { available: false, registered: false, launcherPath: null, hint: null }
    if (process.platform === 'linux') return this.linuxStatus()
    const registered = await run(this.windowsLauncher, ['--cm-status']).then(
      () => true,
      () => false,
    )
    return { available: true, registered, launcherPath: this.windowsLauncher, hint: null }
  }

  async setRegistered(registered: boolean): Promise<CommandStatus> {
    if (!this.available) throw new Error('Den Befehl „cm“ gibt es nur in der installierten App.')
    if (process.platform === 'linux') {
      if (registered) await this.writeLinuxLauncher()
      else if ((await this.linuxTarget()) !== null) await rm(this.linuxLauncher, { force: true })
      return this.status()
    }
    await run(this.windowsLauncher, [registered ? '--cm-register' : '--cm-unregister'])
    return this.status()
  }

  private async linuxStatus(): Promise<CommandStatus> {
    const target = await this.linuxTarget()
    const registered = target === launchExecutable()
    let hint: string | null = null
    if (target === null && existsSync(this.linuxLauncher)) {
      hint = '~/.local/bin/cm gehört zu einem anderen Programm und bleibt unverändert.'
    } else if (!this.binDirOnPath()) {
      hint = '~/.local/bin steht nicht im PATH. Ergänze in ~/.profile: export PATH="$HOME/.local/bin:$PATH" und melde dich neu an.'
    }
    return { available: true, registered, launcherPath: this.linuxLauncher, hint }
  }

  /** The app path in ~/.local/bin/cm when the app wrote it, otherwise `null`. */
  private async linuxTarget(): Promise<string | null> {
    const script = await readFile(this.linuxLauncher, 'utf8').catch(() => null)
    return script === null ? null : launcherTarget(script)
  }

  /** Never replaces a `cm` that belongs to another program. */
  private async writeLinuxLauncher(): Promise<void> {
    if (existsSync(this.linuxLauncher) && (await this.linuxTarget()) === null) {
      throw new Error('~/.local/bin/cm gehört zu einem anderen Programm. Benenne es um oder entferne es, dann klappt es.')
    }
    await mkdir(dirname(this.linuxLauncher), { recursive: true })
    const temp = `${this.linuxLauncher}.${process.pid}.tmp`
    await writeFile(temp, launcherScript(launchExecutable()), { mode: 0o755 })
    await chmod(temp, 0o755)
    await rename(temp, this.linuxLauncher)
  }

  private binDirOnPath(): boolean {
    const binDir = dirname(this.linuxLauncher)
    return (process.env.PATH ?? '').split(delimiter).some((entry) => entry && resolve(entry) === binDir)
  }
}
