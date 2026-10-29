import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Mirrors Claude Code's own path resolution:
 * - config home: CLAUDE_CONFIG_DIR, else ~/.claude
 * - credentials: <config home>/.credentials.json (plain file on Windows/Linux)
 * - global config: legacy <config home>/.config.json when it is a non-empty file,
 *   else (CLAUDE_CONFIG_DIR || $HOME)/.claude.json — note `.claude.json` lives in the
 *   home dir (not inside ~/.claude) when CLAUDE_CONFIG_DIR is not set.
 */
export interface ClaudePaths {
  configDir: string
  credentialsFile: string
  globalConfigFile: string
  projectsDir: string
  sessionsDir: string
}

export function defaultClaudeConfigDir(): string {
  return join(homedir(), '.claude')
}

/**
 * @param configDir   the config home Claude Code will use
 * @param viaEnv      whether Claude Code receives it through CLAUDE_CONFIG_DIR
 */
export function claudePaths(configDir: string, viaEnv: boolean): ClaudePaths {
  const legacy = join(configDir, '.config.json')
  let globalConfigFile = join(viaEnv ? configDir : homedir(), '.claude.json')
  try {
    const st = statSync(legacy)
    if (st.isFile() && st.size > 0) globalConfigFile = legacy
  } catch {
    // no legacy file
  }
  return {
    configDir,
    credentialsFile: join(configDir, '.credentials.json'),
    globalConfigFile,
    projectsDir: join(configDir, 'projects'),
    sessionsDir: join(configDir, 'sessions'),
  }
}
