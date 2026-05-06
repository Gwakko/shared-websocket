import './utils/disposable';
import type { Unsubscribe, Logger } from './types';

interface SyncMessage {
  key: string;
  value: unknown;
  deleted?: boolean;
}

interface TabSyncOptions {
  /** Enable debug logging (default: false). */
  debug?: boolean;
  /** Custom logger (default: console). */
  logger?: Logger;
}

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Cross-tab state synchronization via BroadcastChannel.
 * No WebSocket needed — works standalone for sharing state between browser tabs.
 *
 * @example
 * const sync = new TabSync('my-app');
 * sync.set('theme', 'dark');
 * sync.on('theme', (theme) => applyTheme(theme));
 *
 * @example
 * // With debug logging
 * const sync = new TabSync('my-app', { debug: true });
 */
export class TabSync implements Disposable {
  private store = new Map<string, unknown>();
  private listeners = new Map<string, Set<(value: unknown) => void>>();
  private bc: BroadcastChannel;
  private disposed = false;
  private readonly log: Logger;

  constructor(channel = 'tab-sync', options?: TabSyncOptions) {
    this.log = options?.debug ? (options.logger ?? console) : NOOP_LOGGER;
    this.log.debug('[TabSync] init', { channel });
    this.bc = new BroadcastChannel(channel);
    this.bc.onmessage = (ev: MessageEvent<SyncMessage>) => {
      const { key, value, deleted } = ev.data;
      if (deleted) {
        this.store.delete(key);
        this.log.debug('[TabSync] ← remote delete', key);
      } else {
        this.store.set(key, value);
        this.log.debug('[TabSync] ← remote set', key, value);
      }
      this.emit(key, value);
    };
  }

  /** Set a value and broadcast to all tabs. Local listeners also fire. */
  set<T>(key: string, value: T): void {
    this.store.set(key, value);
    this.bc.postMessage({ key, value } satisfies SyncMessage);
    this.log.debug('[TabSync] → set', key, value);
    this.emit(key, value);
  }

  /** Get current value from local store. */
  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  /** Delete a key and broadcast deletion to all tabs. */
  delete(key: string): void {
    this.store.delete(key);
    this.bc.postMessage({ key, value: undefined, deleted: true } satisfies SyncMessage);
    this.log.debug('[TabSync] → delete', key);
    this.emit(key, undefined);
  }

  /** Check if a key exists in the local store. */
  has(key: string): boolean {
    return this.store.has(key);
  }

  /** Get all keys in the local store. */
  keys(): string[] {
    return [...this.store.keys()];
  }

  /** Get number of entries. */
  get size(): number {
    return this.store.size;
  }

  /**
   * Listen for changes to a key. Fires when any tab (including this one) calls set().
   *
   * @example
   * sync.on('cart', (cart) => updateBadge(cart.items.length));
   */
  on<T>(key: string, fn: (value: T) => void): Unsubscribe {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    const wrapper = fn as (value: unknown) => void;
    set.add(wrapper);
    return () => set!.delete(wrapper);
  }

  /** Listen for a key change once, then auto-unsubscribe. */
  once<T>(key: string, fn: (value: T) => void): Unsubscribe {
    const unsub = this.on<T>(key, (value) => {
      unsub();
      fn(value);
    });
    return unsub;
  }

  /** Clear all keys and notify listeners. */
  clear(): void {
    const keys = [...this.store.keys()];
    this.log.debug('[TabSync] → clear', keys);
    this.store.clear();
    for (const key of keys) {
      this.bc.postMessage({ key, value: undefined, deleted: true } satisfies SyncMessage);
      this.emit(key, undefined);
    }
  }

  /** Dispose — close BroadcastChannel and clear all state. */
  dispose(): void {
    this[Symbol.dispose]();
  }

  private emit(key: string, value: unknown): void {
    const set = this.listeners.get(key);
    if (set) {
      for (const fn of set) fn(value);
    }
  }

  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bc.close();
    this.store.clear();
    this.listeners.clear();
  }
}
