import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { GitBranch } from '@shared/types'

let onBranchChanged: (cwd: string, branch: GitBranch | null) => void
const api = {
  git: {
    branch: vi.fn(async (cwd: string): Promise<GitBranch | null> => (cwd.startsWith('/repo') ? { name: `main@${cwd}`, detached: false } : null)),
    webUrl: vi.fn(async (cwd: string) => (cwd.startsWith('/repo') ? `https://github.com/owner${cwd}` : null)),
    watch: vi.fn(async () => {}),
    onBranchChanged: (cb: typeof onBranchChanged) => {
      onBranchChanged = cb
      return () => {}
    },
  },
  window: { onState: () => () => {} },
}

/** Lets the loads answer and the queued flush run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function store() {
  const { useGitStore } = await import('./git')
  return useGitStore()
}

beforeEach(() => {
  vi.stubGlobal('window', { api })
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useGitStore', () => {
  it('loads a folder once for all tabs that show it and watches it', async () => {
    const git = await store()
    git.hold('/repo/a')
    git.hold('/repo/a')
    await settle()
    expect(api.git.branch).toHaveBeenCalledTimes(1)
    expect(git.repos.get('/repo/a')).toEqual({
      branch: { name: 'main@/repo/a', detached: false },
      webUrl: 'https://github.com/owner/repo/a',
    })
    expect(api.git.watch).toHaveBeenLastCalledWith(['/repo/a'])
  })

  it('keeps the folder while one tab still shows it', async () => {
    const git = await store()
    git.hold('/repo/a')
    git.hold('/repo/a')
    await settle()
    git.release('/repo/a')
    await settle()
    expect(git.repos.has('/repo/a')).toBe(true)
    git.release('/repo/a')
    await settle()
    expect(git.repos.has('/repo/a')).toBe(false)
    expect(api.git.watch).toHaveBeenLastCalledWith([])
  })

  it('neither drops nor reloads a folder let go and taken again in the same tick', async () => {
    const git = await store()
    git.hold('/repo/a')
    await settle()
    // A tab moved to another group: unmounted there, mounted here.
    git.release('/repo/a')
    git.hold('/repo/a')
    await settle()
    expect(git.repos.has('/repo/a')).toBe(true)
    expect(api.git.branch).toHaveBeenCalledTimes(1)
    expect(api.git.watch).toHaveBeenCalledTimes(1)
  })

  it('watches all folders shown at once', async () => {
    const git = await store()
    git.hold('/repo/a')
    git.hold('/repo/b')
    git.hold('/plain')
    await settle()
    expect(api.git.watch).toHaveBeenCalledTimes(1)
    expect(api.git.watch).toHaveBeenLastCalledWith(['/repo/a', '/repo/b', '/plain'])
    expect(git.repos.get('/plain')).toEqual({ branch: null, webUrl: null })
  })

  it('takes a checkout reported by main', async () => {
    const git = await store()
    git.hold('/repo/a')
    await settle()
    onBranchChanged('/repo/a', { name: 'next', detached: false })
    onBranchChanged('/repo/other', { name: 'ignored', detached: false })
    expect(git.repos.get('/repo/a')?.branch).toEqual({ name: 'next', detached: false })
    expect(git.repos.has('/repo/other')).toBe(false)
  })

  it('drops the answer for a folder no tab shows anymore', async () => {
    const git = await store()
    git.hold('/repo/a')
    git.release('/repo/a')
    await settle()
    expect(git.repos.has('/repo/a')).toBe(false)
  })

  it('asks again for every folder when the window gets the focus', async () => {
    const git = await store()
    const { useAppStore } = await import('./app')
    const app = useAppStore()
    git.hold('/repo/a')
    await settle()
    app.windowState = { ...app.windowState, focused: false }
    await nextTick()
    app.windowState = { ...app.windowState, focused: true }
    await settle()
    expect(api.git.branch).toHaveBeenCalledTimes(2)
    expect(api.git.watch).toHaveBeenCalledTimes(2)
  })
})
