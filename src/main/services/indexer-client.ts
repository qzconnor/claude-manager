import type { IndexerRequest, IndexerResponse } from '../workers/indexer-protocol'

/** What the client needs of the worker thread (a stand-in in tests). */
export interface IndexerWorker {
  postMessage(message: { id: number; request: IndexerRequest }): void
  terminate(): Promise<number>
  on(event: 'message', listener: (message: IndexerResponse) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
}

/** A request without an answer for this long fails, and the worker is asked whether it is alive. */
export const REQUEST_TIMEOUT_MS = 120_000
/**
 * The worker answers a ping between two files. Without an answer for this long it hangs: it is ended
 * and started anew. Reading one transcript of a gigabyte takes some seconds.
 */
export const PING_TIMEOUT_MS = 30_000
/** After a crash the worker starts again after 1 s, after each further crash in a row twice as late. */
export const RESTART_DELAY_MS = 1000
export const MAX_RESTART_DELAY_MS = 60_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Talks to the transcript indexer worker. A worker that crashed starts again with the next request,
 * a hanging one is ended. If it keeps crashing (e.g. out of memory on a huge transcript), each restart
 * waits longer, up to a minute, instead of reading everything again right away.
 */
export class IndexerClient {
  private worker: IndexerWorker | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  /** Crashes and hangs in a row, without an answer in between. */
  private failures = 0
  private restartAt = 0
  private checking = false
  private disposed = false

  constructor(private readonly spawn: () => IndexerWorker) {}

  async request<T>(request: IndexerRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const delay = this.restartAt - Date.now()
    if (delay > 0 && !this.worker) await wait(delay)
    if (this.disposed) throw new Error('Indexer wurde beendet.')
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Der Index antwortet nicht.'))
        if (request.method !== 'ping') void this.checkAlive(worker)
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      worker.postMessage({ id, request })
    })
  }

  dispose(): void {
    this.disposed = true
    const worker = this.worker
    this.worker = null
    void worker?.terminate()
    this.failAll(new Error('Indexer wurde beendet.'))
  }

  private ensureWorker(): IndexerWorker {
    if (this.worker) return this.worker
    const worker = this.spawn()
    let failure: Error | null = null
    worker.on('message', (message: IndexerResponse) => {
      if (this.worker !== worker) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      this.failures = 0
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error))
    })
    worker.on('error', (error) => {
      console.error('[indexer] worker error', error)
      failure = error instanceof Error ? error : new Error(String(error))
    })
    // A worker ended or replaced on purpose is no longer `this.worker`: its exit fails nothing.
    worker.on('exit', () => {
      if (this.worker !== worker) return
      this.failed(failure ?? new Error('Indexer wurde unerwartet beendet.'))
    })
    this.worker = worker
    return worker
  }

  /** A request took long: is the worker busy, or does it hang? */
  private async checkAlive(worker: IndexerWorker): Promise<void> {
    if (this.checking || this.worker !== worker) return
    this.checking = true
    try {
      await this.request({ method: 'ping' }, PING_TIMEOUT_MS)
    } catch {
      if (this.worker !== worker) return
      console.error('[indexer] worker hangs, restarting it')
      this.failed(new Error('Der Index hing und wird neu gestartet.'))
      void worker.terminate()
    } finally {
      this.checking = false
    }
  }

  /** The worker is gone: its requests fail, the next one starts a new worker, later after each failure. */
  private failed(error: Error): void {
    this.worker = null
    this.failures++
    this.restartAt = Date.now() + Math.min(MAX_RESTART_DELAY_MS, RESTART_DELAY_MS * 2 ** (this.failures - 1))
    this.failAll(error)
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
