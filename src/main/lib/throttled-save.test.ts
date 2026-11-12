import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThrottledSave } from './throttled-save'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('ThrottledSave', () => {
  it('saves a burst once, a few seconds after its first change', () => {
    const save = vi.fn()
    const saver = new ThrottledSave(save, 3000, 60_000)
    saver.schedule()
    vi.advanceTimersByTime(1000)
    saver.schedule()
    saver.schedule()
    vi.advanceTimersByTime(1999)
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('saves changes that never stop once a minute, not only at their end', () => {
    const save = vi.fn()
    const saver = new ThrottledSave(save, 3000, 60_000)
    // A session at work: a change every second for three minutes.
    for (let second = 0; second < 180; second++) {
      saver.schedule()
      vi.advanceTimersByTime(1000)
    }
    // At 3 s, 63 s, 123 s.
    expect(save).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(60_000)
    expect(save).toHaveBeenCalledTimes(4)
    // Nothing changed since: nothing more to save.
    vi.advanceTimersByTime(600_000)
    expect(save).toHaveBeenCalledTimes(4)
  })

  it('saves a change long after the last save after the short delay', () => {
    const save = vi.fn()
    const saver = new ThrottledSave(save, 3000, 60_000)
    saver.schedule()
    vi.advanceTimersByTime(3000)
    vi.advanceTimersByTime(120_000)
    saver.schedule()
    vi.advanceTimersByTime(3000)
    expect(save).toHaveBeenCalledTimes(2)
  })
})
