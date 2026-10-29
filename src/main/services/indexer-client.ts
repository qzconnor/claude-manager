import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import createIndexerWorker from '../workers/indexer.worker?nodeWorker'
import type { IndexerRequest, IndexerResponse } from '../workers/indexer-protocol'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** Talks to the transcript indexer worker; restarts it transparently if it crashes. */
export class IndexerClient {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly userDataDir: string) {}

  request<T>(request: IndexerRequest): Promise<T> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      worker.postMessage({ id, request })
    })
  }

  dispose(): void {
    void this.worker?.terminate()
    this.worker = null
    this.failAll(new Error('Indexer wurde beendet.'))
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = createIndexerWorker({
      workerData: { cacheFile: join(this.userDataDir, 'cache', 'transcript-index.json') },
    })
    worker.on('message', (message: IndexerResponse) => {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error))
    })
    worker.on('error', (error) => {
      console.error('[indexer] worker error', error)
      this.failAll(error instanceof Error ? error : new Error(String(error)))
    })
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = null
      this.failAll(new Error('Indexer wurde unerwartet beendet.'))
    })
    this.worker = worker
    return worker
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
