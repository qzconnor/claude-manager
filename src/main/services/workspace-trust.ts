import { homedir } from 'node:os'
import type { DialogOptions } from '@shared/types'
import { isHomeFolder, trustFolder, trustTarget, type TrustTarget } from '../lib/workspace-trust'
import type { AccountService } from './account-service'

/** Asks the user in the window: true for yes, null when there is no window to ask in. */
export type TrustQuestion = (options: DialogOptions) => Promise<boolean | null>

/**
 * Asks in the app whether Claude Code may work in a folder before a session starts there, instead of
 * Claude Code asking in the terminal, and saves a yes where Claude Code looks for it.
 */
export class WorkspaceTrust {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly accounts: AccountService,
    private readonly ask: TrustQuestion,
  ) {}

  /**
   * The folder to start Claude Code in, spelled like its entry in the account's config, or null when
   * the user said no. When the config can't be read or written, Claude Code asks itself as before.
   */
  ensure(accountId: string, cwd: string): Promise<string | null> {
    // One question at a time, so a second tab in the same folder gets the first one's answer.
    const run = this.queue.then(() => this.ensureNow(accountId, cwd))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async ensureNow(accountId: string, cwd: string): Promise<string | null> {
    const configFile = this.accounts.paths(accountId).globalConfigFile
    let target: TrustTarget
    try {
      target = await trustTarget(configFile, cwd)
    } catch (error) {
      console.warn('[trust] config could not be read, Claude Code asks itself', error)
      return cwd
    }
    if (target.trusted) return target.cwd
    // In the home folder Claude Code asks itself and keeps a yes for the running session only;
    // saved, it would cover every folder below that isn't a git repository.
    if (isHomeFolder(target.folder, homedir())) return target.cwd
    const answer = await this.ask(this.question(accountId, target))
    if (answer === false) return null
    if (answer === true) {
      try {
        await trustFolder(configFile, target)
      } catch (error) {
        console.warn('[trust] could not be saved, Claude Code asks itself', error)
      }
    }
    return target.cwd
  }

  private question(accountId: string, target: TrustTarget): DialogOptions {
    const paragraphs = [
      'Claude Code kann in diesem Ordner Dateien lesen, bearbeiten und ausführen. Vertraue nur eigenen Projekten, Code aus deinem Team oder bekannten Open-Source-Projekten.',
    ]
    if (target.folder !== target.cwd) paragraphs.push(`Das gilt für das ganze Git-Repository „${target.folder}“.`)
    if (this.accounts.list().length > 1) {
      paragraphs.push(`Claude Code merkt sich das für den Account „${this.accounts.get(accountId).name}“.`)
    }
    return {
      title: 'Diesem Ordner vertrauen?',
      code: target.cwd,
      description: paragraphs.join('\n\n'),
      confirmText: 'Ordner vertrauen',
      warning: true,
    }
  }
}
