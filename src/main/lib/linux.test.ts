import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { launchExecutable, withoutAppImageEnv } from './linux'

const electron = vi.hoisted(() => ({ app: { isPackaged: true } }))
vi.mock('electron', () => electron)

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...platform, value })
}

function setResourcesPath(value: string): void {
  Object.defineProperty(process, 'resourcesPath', { value, configurable: true, writable: true })
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
  electron.app.isPackaged = true
  setPlatform('linux')
  setResourcesPath(dir)
  vi.stubEnv('APPIMAGE', undefined)
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath)
  else delete (process as { resourcesPath?: string }).resourcesPath
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

/** A fresh copy of the module: it remembers the package type. */
async function linuxPackage() {
  vi.resetModules()
  return (await import('./linux')).linuxPackage
}

describe('linuxPackage', () => {
  it('is an AppImage when the AppImage runtime set APPIMAGE', async () => {
    vi.stubEnv('APPIMAGE', '/home/user/Apps/Claude-Manager.AppImage')
    await writeFile(join(dir, 'package-type'), 'deb')
    expect((await linuxPackage())()).toBe('appimage')
  })

  it.each(['deb', 'rpm'])('reads %s from the package-type file next to the app', async (type) => {
    await writeFile(join(dir, 'package-type'), `${type}\n`)
    expect((await linuxPackage())()).toBe(type)
  })

  it('is null for an unpacked build or an unknown package type', async () => {
    expect((await linuxPackage())()).toBeNull()
    await writeFile(join(dir, 'package-type'), 'pacman')
    expect((await linuxPackage())()).toBeNull()
  })

  it('is null in development and on other systems', async () => {
    await writeFile(join(dir, 'package-type'), 'deb')
    electron.app.isPackaged = false
    expect((await linuxPackage())()).toBeNull()
    electron.app.isPackaged = true
    setPlatform('win32')
    expect((await linuxPackage())()).toBeNull()
  })

  it('remembers the answer', async () => {
    await writeFile(join(dir, 'package-type'), 'rpm')
    const read = await linuxPackage()
    expect(read()).toBe('rpm')
    await rm(join(dir, 'package-type'))
    expect(read()).toBe('rpm')
  })
})

describe('launchExecutable', () => {
  it('is the AppImage file on Linux, otherwise the executable', () => {
    expect(launchExecutable()).toBe(process.execPath)
    vi.stubEnv('APPIMAGE', '/home/user/Apps/Claude-Manager.AppImage')
    expect(launchExecutable()).toBe('/home/user/Apps/Claude-Manager.AppImage')
    setPlatform('win32')
    expect(launchExecutable()).toBe(process.execPath)
  })
})

describe('withoutAppImageEnv', () => {
  const APPDIR = '/tmp/.mount_ClaudeAbc123'

  it('removes the mount from search paths and the variables of the AppImage runtime', () => {
    const env: Record<string, string> = {
      APPDIR,
      APPIMAGE: '/home/user/Claude-Manager.AppImage',
      ARGV0: 'Claude-Manager.AppImage',
      OWD: '/home/user',
      PATH: `${APPDIR}/usr/bin:/usr/local/bin::/usr/bin:${APPDIR}`,
      LD_LIBRARY_PATH: `${APPDIR}/usr/lib:${APPDIR}/lib`,
      XDG_DATA_DIRS: `${APPDIR}/usr/share:/usr/local/share:/usr/share`,
      HOME: '/home/user',
    }
    const result = withoutAppImageEnv(env)
    expect(result).toBe(env)
    expect(result).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      XDG_DATA_DIRS: '/usr/local/share:/usr/share',
      HOME: '/home/user',
    })
  })

  it('keeps folders that only share the prefix of the mount', () => {
    const env = { APPDIR, PATH: `${APPDIR}-other/bin:${APPDIR}/bin` }
    expect(withoutAppImageEnv(env)).toEqual({ PATH: `${APPDIR}-other/bin` })
  })

  it('leaves the environment alone outside an AppImage', () => {
    const env = { APPIMAGE: 'x', PATH: '/usr/bin' }
    expect(withoutAppImageEnv({ ...env })).toEqual(env)
    setPlatform('win32')
    const windows = { APPDIR: 'C:\\app', PATH: 'C:\\app\\bin;C:\\Windows' }
    expect(withoutAppImageEnv({ ...windows })).toEqual(windows)
  })
})
