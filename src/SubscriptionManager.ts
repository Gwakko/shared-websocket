import './utils/disposable';
import type { EventHandler, Unsubscribe } from './types';

export class SubscriptionManager implements Disposable {
  private handlers = new Map<string, Set<EventHandler>>();
  private lastMessages = new Map<string, unknown>();

  on(event: string, handler: EventHandler): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  once(event: string, handler: EventHandler): Unsubscribe {
    const wrapper: EventHandler = (data) => {
      unsub();
      handler(data);
    };
    const unsub = this.on(event, wrapper);
    return unsub;
  }

  off(event: string, handler?: EventHandler): void {
    if (handler) {
      this.handlers.get(event)?.delete(handler);
    } else {
      this.handlers.delete(event);
    }
  }

  emit(event: string, data: unknown): void {
    this.lastMessages.set(event, data);
    const set = this.handlers.get(event);
    if (set) {
      for (const fn of set) fn(data);
    }
  }

  getLastMessage(event: string): unknown | undefined {
    return this.lastMessages.get(event);
  }

  async *stream(event: string, signal?: AbortSignal): AsyncGenerator<unknown> {
    const queue: unknown[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const unsub = this.on(event, (data) => {
      queue.push(data);
      resolve?.();
    });

    const onAbort = () => {
      done = true;
      resolve?.();
    };
    signal?.addEventListener('abort', onAbort);

    try {
      while (!done) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise<void>((r) => { resolve = r; });
          resolve = null;
        }
      }
    } finally {
      unsub();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  offAll(): void {
    this.handlers.clear();
    this.lastMessages.clear();
  }

  [Symbol.dispose](): void {
    this.offAll();
  }
}
