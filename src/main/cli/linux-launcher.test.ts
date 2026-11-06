import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readLaunchRequest } from './launch'
import { LAUNCHER_MARK, launcherScript, launcherTarget } from './linux-launcher'

describe('launcherScript', () => {
  it('is a marked shell script with the quoted app path', () => {
    const script = launcherScript('/opt/Claude Manager/claude-manager')
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain(`\n${LAUNCHER_MARK}\n`)
    expect(script).toContain("\nAPP='/opt/Claude Manager/claude-manager'\n")
  })

  it('escapes single quotes in the app path', () => {
    expect(launcherScript("/home/o'brien/app")).toContain(`\nAPP='/home/o'\\''brien/app'\n`)
  })
})

describe('launcherTarget', () => {
  it.each([
    ['a plain path', '/home/me/Applications/Claude-Manager.AppImage'],
    ['spaces', '/opt/Claude Manager/claude-manager'],
    ['single quotes', "/home/o'brien/it's/app"],
    ['shell characters', '/tmp/$HOME/`id`/"x"/back\\slash'],
  ])('reads back the app path with %s', (_name, app) => {
    expect(launcherTarget(launcherScript(app))).toBe(app)
  })

  it('is null for a script the app did not write', () => {
    expect(launcherTarget("#!/bin/sh\nAPP='/usr/bin/other'\nexec \"$APP\"\n")).toBeNull()
  })

  it('is null for a marked script without an app line', () => {
    expect(launcherTarget(`#!/bin/sh\n${LAUNCHER_MARK}\necho hi\n`)).toBeNull()
  })
})

describe.runIf(process.platform === 'linux')('the script under sh', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  })

  async function install(app: string): Promise<string> {
    const script = join(dir, 'cm')
    await writeFile(script, launcherScript(app))
    await chmod(script, 0o755)
    return script
  }

  it('hands the folder and the arguments to the app', async () => {
    const out = join(dir, 'args.txt')
    // Stands in for the app: writes the switch it got.
    const app = join(dir, 'fake app')
    await writeFile(app, `#!/bin/sh\nprintf '%s' "$1" > '${out}'\n`)
    await chmod(app, 0o755)
    const script = await install(app)

    const args = ['-a', 'Work Team', '--', '--append-system-prompt', "it's \"quoted\"", '']
    execFileSync('sh', [script, ...args], { cwd: dir })
    await expect.poll(() => readFile(out, 'utf8').catch(() => ''), { timeout: 5000 }).not.toBe('')

    const request = readLaunchRequest([await readFile(out, 'utf8')])
    expect(request).toEqual({ cwd: await realpath(dir), args })
  })

  it('prints the help, even when the app is gone', async () => {
    const script = await install(join(dir, 'missing-app'))
    expect(execFileSync('sh', [script, '--help'], { encoding: 'utf8' })).toContain('cm -a <account>')
  })

  it('fails with a message when the app is gone', async () => {
    const script = await install(join(dir, 'missing-app'))
    let error: { status?: number; stderr?: string } = {}
    try {
      execFileSync('sh', [script], { encoding: 'utf8', stdio: 'pipe' })
    } catch (caught) {
      error = caught as typeof error
    }
    expect(error.status).toBe(1)
    expect(error.stderr).toContain('Claude Manager wurde nicht gefunden')
  })
})
