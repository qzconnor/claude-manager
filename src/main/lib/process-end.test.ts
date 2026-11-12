import { describe, expect, it, vi } from 'vitest'
import { awaitEnd, settles } from './process-end'

describe('settles', () => {
  it('tells whether the promise resolved in time', async () => {
    expect(await settles(Promise.resolve(), 50)).toBe(true)
    expect(await settles(new Promise(() => {}), 10)).toBe(false)
  })
})

describe('awaitEnd', () => {
  it('does not kill hard a process that ends in time', async () => {
    const force = vi.fn(async () => {})
    await awaitEnd(Promise.resolve(), force, 50)
    expect(force).not.toHaveBeenCalled()
  })

  it('kills hard a process that does not end in time', async () => {
    let end!: () => void
    const exited = new Promise<void>((resolve) => (end = resolve))
    const force = vi.fn(async () => end())
    await awaitEnd(exited, force, 10, 50)
    expect(force).toHaveBeenCalledOnce()
  })

  it('says so when even that does not end it', async () => {
    const force = vi.fn(async () => {})
    await expect(awaitEnd(new Promise(() => {}), force, 10, 10)).rejects.toThrow('lässt sich nicht beenden')
    expect(force).toHaveBeenCalledOnce()
  })
})
