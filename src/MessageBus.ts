import './utils/disposable';
import { generateId } from './utils/id';
import type { BusMessage, Unsubscribe } from './types';

type Listener = (msg: BusMessage) => void;

export class MessageBus implements Disposable {
  private channel: BroadcastChannel;
  private listeners = new Map<string, Set<Listener>>();
  private pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    channelName: string,
    private readonly tabId: string,
  ) {
    this.channel = new BroadcastChannel(channelName);
    this.channel.onmessage = (ev: MessageEvent<BusMessage>) => {
      this.handleMessage(ev.data);
    };
  }

  subscribe<T>(topic: string, fn: (data: T) => void): Unsubscribe {
    const wrapper: Listener = (msg) => {
      if (msg.source !== this.tabId) fn(msg.data as T);
    };
    this.addListener(topic, wrapper);
    return () => this.removeListener(topic, wrapper);
  }

  publish<T>(topic: string, data: T): void {
    this.postMessage({ topic, type: 'publish', data });
  }

  broadcast<T>(topic: string, data: T): void {
    const msg = this.createMessage(topic, 'broadcast', data);
    this.channel.postMessage(msg);
    // Also deliver to self
    this.handleMessage(msg);
  }

  async request<T, R>(topic: string, data: T, timeout = 5000): Promise<R> {
    const msg = this.createMessage(topic, 'request', data);
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(msg.id);
        reject(new Error(`MessageBus.request: timeout for topic "${topic}"`));
      }, timeout);
      this.pendingRequests.set(msg.id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.channel.postMessage(msg);
    });
  }

  respond<T, R>(topic: string, fn: (data: T) => R | Promise<R>): Unsubscribe {
    const wrapper: Listener = async (msg) => {
      if (msg.type !== 'request' || msg.source === this.tabId) return;
      const result = await fn(msg.data as T);
      this.postMessage({ topic, type: 'response', data: { requestId: msg.id, result } });
    };
    this.addListener(topic, wrapper);
    return () => this.removeListener(topic, wrapper);
  }

  private handleMessage(msg: BusMessage): void {
    // Handle response to pending request
    if (msg.type === 'response') {
      const payload = msg.data as { requestId: string; result: unknown };
      const pending = this.pendingRequests.get(payload.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(payload.requestId);
        pending.resolve(payload.result);
        return;
      }
    }

    const listeners = this.listeners.get(msg.topic);
    if (listeners) {
      for (const fn of listeners) fn(msg);
    }
  }

  private postMessage(partial: Pick<BusMessage, 'topic' | 'type' | 'data'>): void {
    this.channel.postMessage(this.createMessage(partial.topic, partial.type, partial.data));
  }

  private createMessage(topic: string, type: BusMessage['type'], data: unknown): BusMessage {
    return { id: generateId(), source: this.tabId, topic, type, data, timestamp: Date.now() };
  }

  private addListener(topic: string, fn: Listener): void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(fn);
  }

  private removeListener(topic: string, fn: Listener): void {
    this.listeners.get(topic)?.delete(fn);
  }

  [Symbol.dispose](): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MessageBus disposed'));
    }
    this.pendingRequests.clear();
    this.listeners.clear();
    this.channel.close();
  }
}
