import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudePaths, defaultClaudeConfigDir } from './claude-paths'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('defaultClaudeConfigDir', () => {
  it('is .claude in the home folder', () => {
    expect(defaultClaudeConfigDir()).toBe(join(homedir(), '.claude'))
  })
})

describe('claudePaths', () => {
  it('puts credentials, projects and sessions into the config dir', () => {
    const paths = claudePaths(dir, true)
    expect(paths).toEqual({
      configDir: dir,
      credentialsFile: join(dir, '.credentials.json'),
      globalConfigFile: join(dir, '.claude.json'),
      projectsDir: join(dir, 'projects'),
      sessionsDir: join(dir, 'sessions'),
    })
  })

  it('looks for .claude.json in the home folder when the dir is not passed via CLAUDE_CONFIG_DIR', () => {
    expect(claudePaths(dir, false).globalConfigFile).toBe(join(homedir(), '.claude.json'))
  })

  it('prefers a non-empty legacy .config.json', async () => {
    await writeFile(join(dir, '.config.json'), '{"projects":{}}')
    expect(claudePaths(dir, true).globalConfigFile).toBe(join(dir, '.config.json'))
    expect(claudePaths(dir, false).globalConfigFile).toBe(join(dir, '.config.json'))
  })

  it('ignores an empty legacy .config.json', async () => {
    await writeFile(join(dir, '.config.json'), '')
    expect(claudePaths(dir, true).globalConfigFile).toBe(join(dir, '.claude.json'))
  })

  it('ignores a folder named .config.json', async () => {
    await mkdir(join(dir, '.config.json'))
    expect(claudePaths(dir, true).globalConfigFile).toBe(join(dir, '.claude.json'))
  })
})
