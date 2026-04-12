import './utils/disposable';
import { generateId } from './utils/id';
import { MessageBus } from './MessageBus';
import { TabCoordinator } from './TabCoordinator';
import { SharedSocket } from './SharedSocket';
import { SubscriptionManager } from './SubscriptionManager';
import type { SharedWebSocketOptions, TabRole, Unsubscribe, EventHandler } from './types';

/**
 * SharedWebSocket — shares ONE WebSocket connection across browser tabs.
 *
 * One tab becomes the "leader" and holds the WebSocket.
 * Other tabs are "followers" receiving data via BroadcastChannel.
 * If the leader closes, a new leader is elected automatically.
 */
export class SharedWebSocket implements Disposable {
  private bus: MessageBus;
  private coordinator: TabCoordinator;
  private socket: SharedSocket | null = null;
  private subs = new SubscriptionManager();
  private syncStore = new Map<string, unknown>();
  private tabId: string;
  private cleanups: Unsubscribe[] = [];
  private disposed = false;

  constructor(
    private readonly url: string,
    private readonly options: SharedWebSocketOptions = {},
  ) {
    this.tabId = generateId();
    this.bus = new MessageBus('shared-ws', this.tabId);
    this.coordinator = new TabCoordinator(this.bus, this.tabId, {
      electionTimeout: options.electionTimeout,
      heartbeatInterval: options.leaderHeartbeat,
      leaderTimeout: options.leaderTimeout,
    });

    // When ANY tab receives a WS message via bus → emit to local subscribers
    this.cleanups.push(
      this.bus.subscribe<{ event: string; data: unknown }>('ws:message', (msg) => {
        this.subs.emit(msg.event, msg.data);
      }),
    );

    // Leader listens for send requests from followers
    this.cleanups.push(
      this.bus.subscribe<{ event: string; data: unknown }>('ws:send', (msg) => {
        if (this.coordinator.isLeader && this.socket) {
          this.socket.send({ event: msg.event, data: msg.data });
        }
      }),
    );

    // Sync across tabs
    this.cleanups.push(
      this.bus.subscribe<{ key: string; value: unknown }>('ws:sync', (msg) => {
        this.syncStore.set(msg.key, msg.value);
        this.subs.emit(`sync:${msg.key}`, msg.value);
      }),
    );

    // Leader lifecycle
    this.coordinator.onBecomeLeader(() => this.onBecomeLeader());
    this.coordinator.onLoseLeadership(() => this.onLoseLeadership());

    // Cleanup on tab close
    if (typeof window !== 'undefined') {
      const onBeforeUnload = () => this[Symbol.dispose]();
      window.addEventListener('beforeunload', onBeforeUnload);
      this.cleanups.push(() => window.removeEventListener('beforeunload', onBeforeUnload));
    }
  }

  get connected(): boolean {
    return this.socket?.state === 'connected' || !this.coordinator.isLeader;
  }

  get tabRole(): TabRole {
    return this.coordinator.isLeader ? 'leader' : 'follower';
  }

  /** Start leader election and connect. */
  async connect(): Promise<void> {
    await this.coordinator.elect();
  }

  /** Subscribe to server events (works in ALL tabs). */
  on(event: string, handler: EventHandler): Unsubscribe {
    return this.subs.on(event, handler);
  }

  once(event: string, handler: EventHandler): Unsubscribe {
    return this.subs.once(event, handler);
  }

  off(event: string, handler?: EventHandler): void {
    this.subs.off(event, handler);
  }

  /** Async generator for consuming events. */
  stream(event: string, signal?: AbortSignal): AsyncGenerator<unknown> {
    return this.subs.stream(event, signal);
  }

  /** Send message to server (auto-routed through leader). */
  send(event: string, data: unknown): void {
    if (this.coordinator.isLeader && this.socket) {
      this.socket.send({ event, data });
    } else {
      this.bus.publish('ws:send', { event, data });
    }
  }

  /** Request/response through server via leader. */
  async request<T>(event: string, data: unknown, timeout = 5000): Promise<T> {
    return this.bus.request('ws:request', { event, data }, timeout);
  }

  /** Sync state across tabs (no server roundtrip). */
  sync<T>(key: string, value: T): void {
    this.syncStore.set(key, value);
    this.bus.broadcast('ws:sync', { key, value });
  }

  getSync<T>(key: string): T | undefined {
    return this.syncStore.get(key) as T | undefined;
  }

  onSync<T>(key: string, fn: (value: T) => void): Unsubscribe {
    return this.subs.on(`sync:${key}`, fn as EventHandler);
  }

  disconnect(): void {
    this[Symbol.dispose]();
  }

  private onBecomeLeader(): void {
    this.socket = new SharedSocket(this.url, {
      protocols: this.options.protocols,
      reconnect: this.options.reconnect,
      reconnectMaxDelay: this.options.reconnectMaxDelay,
      heartbeatInterval: this.options.heartbeatInterval,
      auth: this.options.auth,
    });

    this.socket.onMessage((data: any) => {
      const event = data?.event ?? 'message';
      const payload = data?.data ?? data;
      // Broadcast to ALL tabs (including self)
      this.bus.broadcast('ws:message', { event, data: payload });
    });

    // Handle send requests from followers (request/response pattern)
    this.cleanups.push(
      this.bus.respond<{ event: string; data: unknown }, unknown>('ws:request', async (req) => {
        return new Promise((resolve) => {
          const unsub = this.socket!.onMessage((response: any) => {
            if (response?.event === req.event || response?.requestId) {
              unsub();
              resolve(response?.data ?? response);
            }
          });
          this.socket!.send({ event: req.event, data: req.data });
        });
      }),
    );

    this.socket.connect();
  }

  private onLoseLeadership(): void {
    if (this.socket) {
      this.socket[Symbol.dispose]();
      this.socket = null;
    }
  }

  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;

    this.coordinator[Symbol.dispose]();

    if (this.socket) {
      this.socket[Symbol.dispose]();
      this.socket = null;
    }

    for (const unsub of this.cleanups) unsub();
    this.cleanups = [];
    this.subs[Symbol.dispose]();
    this.bus[Symbol.dispose]();
    this.syncStore.clear();
  }
}
