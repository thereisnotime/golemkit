// Typed wrapper around EventEmitter.
import { EventEmitter } from 'node:events'

export type EventMap = Record<string, (...args: any[]) => void>

export class TypedEmitter<E extends EventMap> {
  private ee = new EventEmitter()

  constructor () {
    this.ee.setMaxListeners(100)
  }

  on<K extends keyof E & string> (event: K, fn: E[K]): () => void {
    this.ee.on(event, fn)
    return () => { this.ee.off(event, fn) }
  }

  /** Like on(), but runs before the listeners added so far (a brain that must see chat first). */
  prependListener<K extends keyof E & string> (event: K, fn: E[K]): () => void {
    this.ee.prependListener(event, fn)
    return () => { this.ee.off(event, fn) }
  }

  once<K extends keyof E & string> (event: K, fn: E[K]): () => void {
    this.ee.once(event, fn)
    return () => { this.ee.off(event, fn) }
  }

  off<K extends keyof E & string> (event: K, fn: E[K]): void {
    this.ee.off(event, fn)
  }

  emit<K extends keyof E & string> (event: K, ...args: Parameters<E[K]>): void {
    this.ee.emit(event, ...args)
  }
}
