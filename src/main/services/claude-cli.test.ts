import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeCli, escapeCmdArg, fileStamp, npmShimTarget } from './claude-cli'

/** The shim npm 7+ writes for a global package (cmd-shim). */
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\r\n')

/** Arguments cmd.exe would act on if they weren't escaped. */
const TRICKY = ['plain', 'with space', 'a&b', 'a"&echo PWNED&"b', '100%', '%PATH%', 'x^y', 'semi;colon', 'paren(s)', '<redir>', 'pipe|x', 'back\\slash\\', 'q"uote', '!bang!', '']

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-cli-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('npmShimTarget', () => {
  it('finds the script of an npm shim and the node next to it or in the PATH', async () => {
    const script = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    await mkdir(join(script, '..'), { recursive: true })
    await writeFile(script, '')
    const shim = join(dir, 'claude.cmd')
    expect(npmShimTarget(shim, NPM_SHIM, () => 'C:\\node\\node.exe')).toEqual({ file: 'C:\\node\\node.exe', args: [script] })
    await writeFile(join(dir, 'node.exe'), '')
    expect(npmShimTarget(shim, NPM_SHIM, () => null)).toEqual({ file: join(dir, 'node.exe'), args: [script] })
  })

  it('reads the shims of older npm versions and ones that start an executable', async () => {
    await mkdir(join(dir, 'node_modules', 'x'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'x', 'claude.exe'), '')
    const old = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\x\\claude.exe" %*\r\n)'
    expect(npmShimTarget(join(dir, 'claude.cmd'), old, () => null)).toEqual({ file: join(dir, 'node_modules', 'x', 'claude.exe'), args: [] })
  })

  it('leaves other batch files, missing scripts and a missing node to cmd.exe', async () => {
    const shim = join(dir, 'claude.cmd')
    expect(npmShimTarget(shim, '@echo off\r\nclaude.exe %*', () => 'node.exe')).toBeNull()
    expect(npmShimTarget(shim, NPM_SHIM, () => 'node.exe')).toBeNull()
    const script = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    await mkdir(join(script, '..'), { recursive: true })
    await writeFile(script, '')
    expect(npmShimTarget(shim, NPM_SHIM, () => null)).toBeNull()
  })
})

describe('escapeCmdArg', () => {
  it('quotes and escapes what cmd.exe acts on', () => {
    expect(escapeCmdArg('a&b')).toBe('^^^"a^^^&b^^^"')
    expect(escapeCmdArg('%PATH%')).toBe('^^^"^^^%PATH^^^%^^^"')
  })
})

describe.skipIf(process.platform !== 'win32')('ClaudeCli.command with a batch file (Windows)', () => {
  it('passes every argument through cmd.exe and a forwarding batch file unchanged, running nothing', async () => {
    await writeFile(join(dir, 'print.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const batch = join(dir, 'claude.cmd')
    await writeFile(batch, '@node "%~dp0print.js" %*\r\n')
    const { file, args } = new ClaudeCli(() => batch).command(TRICKY)
    expect(typeof args).toBe('string')
    const out = spawnSync(file, [args as string], { windowsVerbatimArguments: true, encoding: 'utf8' }).stdout
    expect(JSON.parse(out)).toEqual(TRICKY)
  })

  it('starts an npm shim directly with node', async () => {
    const script = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    await mkdir(join(script, '..'), { recursive: true })
    await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const shim = join(dir, 'claude.cmd')
    await writeFile(shim, NPM_SHIM)
    const { file, args, display } = new ClaudeCli(() => shim).command(TRICKY)
    expect(file.toLowerCase()).toMatch(/node\.exe$/)
    expect(Array.isArray(args) && args[0]).toBe(script)
    expect(display.startsWith(shim)).toBe(true)
    const out = execFileSync(file, args as string[], { encoding: 'utf8' })
    expect(JSON.parse(out)).toEqual(TRICKY)
  })
})

describe('ClaudeCli.version', () => {
  async function writeClaude(file: string, version: string): Promise<void> {
    if (process.platform === 'win32') await writeFile(file, `@echo ${version} (Claude Code)\r\n`)
    else await writeFile(file, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 })
  }

  it('asks the new version after an update', async () => {
    const exe = join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude')
    await writeClaude(exe, '2.1.0')
    const cli = new ClaudeCli(() => exe)
    expect(await cli.version()).toBe('2.1.0')
    expect(cli.knownVersion()).toBe('2.1.0')
    await writeClaude(exe, '2.1.10')
    expect(cli.knownVersion()).toBeNull()
    expect(await cli.version()).toBe('2.1.10')
  })
})

describe('fileStamp', () => {
  it('changes with the file, and is empty without one', async () => {
    const file = join(dir, 'claude.exe')
    await writeFile(file, 'a')
    const before = fileStamp(file)
    await writeFile(file, 'ab')
    expect(fileStamp(file)).not.toBe(before)
    expect(fileStamp(join(dir, 'missing.exe'))).toBe('')
  })
})
