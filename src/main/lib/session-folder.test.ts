import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fallbackSessionFolder } from './session-folder'

const electron = vi.hoisted(() => ({ app: { getPath: vi.fn<(name: string) => string>() } }))
vi.mock('electron', () => electron)

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
  electron.app.getPath.mockReset()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('fallbackSessionFolder', () => {
  it('is the Downloads folder when it exists', () => {
    electron.app.getPath.mockReturnValue(dir)
    expect(fallbackSessionFolder()).toBe(dir)
    expect(electron.app.getPath).toHaveBeenCalledWith('downloads')
  })

  it('falls back to the home folder when the Downloads folder is missing', () => {
    electron.app.getPath.mockReturnValue(join(dir, 'gone'))
    expect(fallbackSessionFolder()).toBe(homedir())
  })

  it('falls back to the home folder when the system knows no Downloads folder', () => {
    electron.app.getPath.mockImplementation(() => {
      throw new Error('Failed to get downloads path')
    })
    expect(fallbackSessionFolder()).toBe(homedir())
  })
})
