import { afterEach, describe, expect, it, vi } from 'vitest'
import { TypedEmitter } from './typed-emitter'

type Events = {
  changed: [id: string, value: number]
  cleared: []
}

class Service extends TypedEmitter<Events> {
  change(id: string, value: number): void {
    this.emit('changed', id, value)
  }

  clear(): void {
    this.emit('cleared')
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TypedEmitter', () => {
  it('passes the arguments to every listener of the event', () => {
    const service = new Service()
    const first = vi.fn()
    const second = vi.fn()
    const other = vi.fn()
    service.on('changed', first)
    service.on('changed', second)
    service.on('cleared', other)
    service.change('a', 3)
    expect(first).toHaveBeenCalledWith('a', 3)
    expect(second).toHaveBeenCalledWith('a', 3)
    expect(other).not.toHaveBeenCalled()
  })

  it('returns a function that removes just that listener', () => {
    const service = new Service()
    const removed = vi.fn()
    const kept = vi.fn()
    const off = service.on('cleared', removed)
    service.on('cleared', kept)
    off()
    service.clear()
    expect(removed).not.toHaveBeenCalled()
    expect(kept).toHaveBeenCalledTimes(1)
  })

  it('keeps separate emitters apart', () => {
    const a = new Service()
    const b = new Service()
    const listener = vi.fn()
    a.on('cleared', listener)
    b.clear()
    expect(listener).not.toHaveBeenCalled()
  })

  it('allows 50 listeners without a leak warning', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const service = new Service()
    for (let i = 0; i < 50; i++) service.on('changed', () => undefined)
    expect(warn).not.toHaveBeenCalled()
  })
})
