import { EventEmitter } from 'node:events'

/** Minimal strongly typed EventEmitter used by all services. */
export class TypedEmitter<Events extends Record<string, unknown[]>> {
  private readonly emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(50)
  }

  on<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void)
    return () => this.emitter.off(event, listener as (...args: unknown[]) => void)
  }

  protected emit<K extends keyof Events & string>(event: K, ...args: Events[K]): void {
    this.emitter.emit(event, ...args)
  }
}
