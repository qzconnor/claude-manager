import { describe, expect, it, vi } from 'vitest'
import type { ActionContext } from './action-context'

vi.mock('electron', () => ({ nativeImage: {} }))

const { loadPage } = await import('./browser-tools/tool')

/** A page at `start` whose load fails with `error`, ending up at `end`. */
function context(start: string, end: string): { ctx: ActionContext; load: (error: string | null) => () => Promise<void> } {
  let url = start
  const never = () => new Promise<never>(() => undefined)
  const ctx = {
    page: { contents: { getURL: () => url }, settle: async () => undefined },
    untilDialog: never,
    untilLogin: never,
  } as unknown as ActionContext
  return {
    ctx,
    load: (error) => async () => {
      url = end
      if (error) throw new Error(error)
    },
  }
}

describe('loadPage', () => {
  it('is a success when the page loads', async () => {
    const { ctx, load } = context('https://a.test/', 'https://b.test/')
    expect(await loadPage(ctx, 'https://b.test/', load(null))).toBeNull()
  })

  it('is a success when the page went on elsewhere (ERR_ABORTED by a redirect)', async () => {
    const { ctx, load } = context('https://a.test/', 'https://b.test/next')
    expect(await loadPage(ctx, 'https://b.test/', load("ERR_ABORTED (-3) loading 'https://b.test/'"))).toBeNull()
  })

  it('says so when the page stayed where it was (a download, no content)', async () => {
    const { ctx, load } = context('https://a.test/', 'https://a.test/')
    const result = await loadPage(ctx, 'https://a.test/file.zip', load("ERR_ABORTED (-3) loading 'https://a.test/file.zip'"))
    expect(result).toContain('did not open https://a.test/file.zip')
    expect(result).toContain('stayed at https://a.test/')
  })

  it('reports other failures as errors', async () => {
    const { ctx, load } = context('https://a.test/', 'https://a.test/')
    await expect(loadPage(ctx, 'https://nope.test/', load('ERR_NAME_NOT_RESOLVED (-105)'))).rejects.toThrow('could not be opened')
  })
})
