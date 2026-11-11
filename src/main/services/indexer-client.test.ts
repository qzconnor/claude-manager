import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexerRequest } from '../workers/indexer-protocol'
import { IndexerClient, PING_TIMEOUT_MS, REQUEST_TIMEOUT_MS, type IndexerWorker } from './indexer-client'

/** A worker that answers only when told to. */
class FakeWorker extends EventEmitter {
  readonly sent: { id: number; request: IndexerRequest }[] = []
  terminated = false
  postMessage(message: { id: number; request: IndexerRequest }) {
    this.sent.push(message)
  }
  async terminate() {
    this.terminated = true
    this.emit('exit', 1)
    return 1
  }
  answer(method: IndexerRequest['method'], result: unknown) {
    const message = this.sent.find((m) => m.request.method === method)
    if (!message) throw new Error(`nothing asked: ${method}`)
    this.sent.splice(this.sent.indexOf(message), 1)
    this.emit('message', { id: message.id, ok: true, result })
  }
  crash() {
    this.emit('error', new Error('out of memory'))
    this.emit('exit', 1)
  }
}

let workers: FakeWorker[]
let client: IndexerClient
const scan: IndexerRequest = { method: 'scanSessions', projectsDir: '/p' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  workers = []
  client = new IndexerClient(() => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker as unknown as IndexerWorker
  })
})

afterEach(() => {
  client.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Lets the client's awaits and timers up to `ms` run. */
const pass = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('IndexerClient', () => {
  it('starts again after a crash, each time a little later', async () => {
    const first = client.request(scan)
    await pass()
    workers[0]!.crash()
    await expect(first).rejects.toThrow('out of memory')

    // 1 s after the first crash.
    const second = client.request(scan)
    await pass(999)
    expect(workers).toHaveLength(1)
    await pass(1)
    expect(workers).toHaveLength(2)
    workers[1]!.crash()
    await expect(second).rejects.toThrow()

    // 2 s after the second crash in a row.
    void client.request(scan).catch(() => {})
    await pass(1999)
    expect(workers).toHaveLength(2)
    await pass(1)
    expect(workers).toHaveLength(3)
  })

  it('starts right away again once the worker had answered', async () => {
    const first = client.request(scan)
    await pass()
    workers[0]!.answer('scanSessions', [])
    await expect(first).resolves.toEqual([])
    workers[0]!.crash()
    void client.request(scan).catch(() => {})
    await pass(1000)
    workers[1]!.answer('scanSessions', ['again'])
    // The answer resets the count: the next crash waits 1 s again, not 2.
    workers[1]!.crash()
    void client.request(scan).catch(() => {})
    await pass(1000)
    expect(workers).toHaveLength(3)
  })

  it('fails a request without an answer and keeps a worker that is only busy', async () => {
    const slow = client.request(scan)
    const failed = expect(slow).rejects.toThrow('Der Index antwortet nicht.')
    await pass(REQUEST_TIMEOUT_MS)
    await failed
    workers[0]!.answer('ping', true)
    await pass(PING_TIMEOUT_MS)
    expect(workers[0]!.terminated).toBe(false)
    // Still the same worker.
    void client.request(scan).catch(() => {})
    await pass()
    expect(workers).toHaveLength(1)
  })

  it('ends a worker that hangs, and an answer it sends late counts no more', async () => {
    const other = client.request({ method: 'readToolCall', filePath: '/t', toolUseId: 'x' }, REQUEST_TIMEOUT_MS * 2)
    const otherFailed = expect(other).rejects.toThrow('hing')
    void client.request(scan).catch(() => {})
    await pass(REQUEST_TIMEOUT_MS + PING_TIMEOUT_MS)
    expect(workers[0]!.terminated).toBe(true)
    // What was still waiting fails with it.
    await otherFailed

    const next = client.request(scan)
    await pass(1000)
    expect(workers).toHaveLength(2)
    workers[0]!.emit('message', { id: workers[1]!.sent[0]!.id, ok: true, result: 'stale' })
    workers[1]!.answer('scanSessions', 'fresh')
    await expect(next).resolves.toBe('fresh')
  })
})
