import './utils/disposable';
import { generateId } from './utils/id';
import { MessageBus } from './MessageBus';
import { TabCoordinator } from './TabCoordinator';
import { SharedSocket } from './SharedSocket';
import { WorkerSocket } from './WorkerSocket';
import { SubscriptionManager } from './SubscriptionManager';
import type { SharedWebSocketOptions, TabRole, Unsubscribe, EventHandler, Channel, EventProtocol, EventMap, Logger, Middleware } from './types';

const DEFAULT_PROTOCOL: EventProtocol = {
  eventField: 'event',
  dataField: 'data',
  channelJoin: '$channel:join',
  channelLeave: '$channel:leave',
  ping: { type: 'ping' },
  defaultEvent: 'message',
  topicSubscribe: '$topic:subscribe',
  topicUnsubscribe: '$topic:unsubscribe',
};

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Common interface for both SharedSocket and WorkerSocket. */
interface SocketAdapter {
  readonly state: string;
  connect(): void;
  send(data: unknown): void;
  disconnect(): void;
  onMessage(fn: EventHandler): Unsubscribe;
  onStateChange(fn: (state: string) => void): Unsubscribe;
  [Symbol.dispose](): void;
}

/**
 * SharedWebSocket — shares ONE WebSocket connection across browser tabs.
 *
 * @typeParam TEvents - Event map for type-safe subscriptions.
 *
 * @example
 * // Typed events
 * type Events = {
 *   'chat.message': { text: string; userId: string };
 *   'order.created': { id: string; total: number };
 * };
 * const ws = new SharedWebSocket<Events>(url);
 * ws.on('chat.message', (msg) => msg.text); // ← msg: { text, userId }
 */
export class SharedWebSocket<TEvents extends EventMap = EventMap> implements Disposable {
  private bus: MessageBus;
  private coordinator: TabCoordinator;
  private socket: SocketAdapter | null = null;
  private subs = new SubscriptionManager();
  private syncStore = new Map<string, unknown>();
  private tabId: string;
  private cleanups: Unsubscribe[] = [];
  private disposed = false;
  private readonly proto: EventProtocol;
  private readonly log: Logger;
  private outgoingMiddleware: Middleware[] = [];
  private incomingMiddleware: Middleware[] = [];
  private serializers = new Map<string, (data: unknown) => unknown>();
  private deserializers = new Map<string, (data: unknown) => unknown>();

  constructor(
    private readonly url: string,
    private readonly options: SharedWebSocketOptions<TEvents> = {} as SharedWebSocketOptions<TEvents>,
  ) {
    this.proto = { ...DEFAULT_PROTOCOL, ...options.events };
    this.log = options.debug ? (options.logger ?? console) : NOOP_LOGGER;
    this.tabId = generateId();
    this.log.debug('[SharedWS] init', { tabId: this.tabId, url });
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
          this.socket.send({ [this.proto.eventField]: msg.event, [this.proto.dataField]: msg.data });
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
    this.coordinator.onBecomeLeader(() => {
      this.handleBecomeLeader();
      this.bus.broadcast('ws:lifecycle', { type: 'leader', isLeader: true });
    });
    this.coordinator.onLoseLeadership(() => {
      this.handleLoseLeadership();
      this.bus.broadcast('ws:lifecycle', { type: 'leader', isLeader: false });
    });

    // Lifecycle events from bus (all tabs receive)
    this.cleanups.push(
      this.bus.subscribe<{ type: string; isLeader?: boolean; error?: unknown }>('ws:lifecycle', (msg) => {
        switch (msg.type) {
          case 'connect':
            this.subs.emit('$lifecycle:connect', undefined);
            break;
          case 'disconnect':
            this.subs.emit('$lifecycle:disconnect', undefined);
            break;
          case 'reconnecting':
            this.subs.emit('$lifecycle:reconnecting', undefined);
            break;
          case 'leader':
            this.subs.emit('$lifecycle:leader', msg.isLeader);
            break;
          case 'error':
            this.subs.emit('$lifecycle:error', msg.error);
            break;
        }
      }),
    );

    // Track tab visibility
    if (typeof document !== 'undefined') {
      const onVisibilityChange = () => {
        const active = !document.hidden;
        this.subs.emit('$lifecycle:active', active);
        this.log.debug('[SharedWS]', active ? '👁 tab active' : '👁 tab hidden');
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      this.cleanups.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));
    }

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

  /** Whether this tab is currently visible/focused. */
  get isActive(): boolean {
    return typeof document !== 'undefined' ? !document.hidden : true;
  }

  /** Start leader election and connect. */
  async connect(): Promise<void> {
    await this.coordinator.elect();
  }

  // ─── Lifecycle Hooks ─────────────────────────────────

  /** Called when WebSocket connection opens (broadcast to all tabs). */
  onConnect(fn: () => void): Unsubscribe {
    return this.subs.on('$lifecycle:connect', fn);
  }

  /** Called when WebSocket connection closes (broadcast to all tabs). */
  onDisconnect(fn: () => void): Unsubscribe {
    return this.subs.on('$lifecycle:disconnect', fn);
  }

  /** Called when WebSocket starts reconnecting (broadcast to all tabs). */
  onReconnecting(fn: () => void): Unsubscribe {
    return this.subs.on('$lifecycle:reconnecting', fn);
  }

  /** Called when this tab becomes leader or loses leadership. */
  onLeaderChange(fn: (isLeader: boolean) => void): Unsubscribe {
    return this.subs.on('$lifecycle:leader', fn as EventHandler);
  }

  /** Called on WebSocket or network error (broadcast to all tabs). */
  onError(fn: (error: unknown) => void): Unsubscribe {
    return this.subs.on('$lifecycle:error', fn as EventHandler);
  }

  /** Called when this tab becomes visible/focused. */
  onActive(fn: () => void): Unsubscribe {
    return this.subs.on('$lifecycle:active', ((isActive: unknown) => {
      if (isActive === true) fn();
    }) as EventHandler);
  }

  /** Called when this tab goes to background/hidden. */
  onInactive(fn: () => void): Unsubscribe {
    return this.subs.on('$lifecycle:active', ((isActive: unknown) => {
      if (isActive === false) fn();
    }) as EventHandler);
  }

  /** Called on any visibility change. */
  onVisibilityChange(fn: (isActive: boolean) => void): Unsubscribe {
    return this.subs.on('$lifecycle:active', fn as EventHandler);
  }

  // ─── Middleware ───────────────────────────────────────

  /**
   * Add middleware to transform messages before send or after receive.
   * Return null from middleware to drop the message.
   *
   * @example
   * // Add timestamp to every outgoing message
   * ws.use('outgoing', (msg) => ({ ...msg, timestamp: Date.now() }));
   *
   * @example
   * // Decrypt incoming messages
   * ws.use('incoming', (msg) => ({ ...msg, data: decrypt(msg.data) }));
   *
   * @example
   * // Drop messages from blocked users
   * ws.use('incoming', (msg) => blockedUsers.has(msg.userId) ? null : msg);
   */
  use(direction: 'outgoing' | 'incoming', fn: Middleware): this {
    if (direction === 'outgoing') {
      this.outgoingMiddleware.push(fn);
    } else {
      this.incomingMiddleware.push(fn);
    }
    return this;
  }

  // ─── Per-Event Serialization ─────────────────────────

  /**
   * Register a custom serializer for a specific event.
   * The data is transformed before outgoing middleware and global serialize.
   *
   * @example
   * // Binary for file uploads, JSON for everything else
   * ws.serializer('file.upload', (data) => new Blob([data as ArrayBuffer]));
   *
   * @example
   * // Protobuf for specific event
   * ws.serializer('trading.order', (data) => OrderProto.encode(data).finish());
   */
  serializer(event: string, fn: (data: unknown) => unknown): this {
    this.serializers.set(event, fn);
    return this;
  }

  /**
   * Register a custom deserializer for a specific event.
   * The data is transformed after global deserialize and before incoming middleware.
   *
   * @example
   * ws.deserializer('file.download', (data) => new Uint8Array(data as ArrayBuffer));
   *
   * @example
   * // Protobuf for specific event
   * ws.deserializer('trading.tick', (data) => TickProto.decode(data as Uint8Array));
   */
  deserializer(event: string, fn: (data: unknown) => unknown): this {
    this.deserializers.set(event, fn);
    return this;
  }

  // ─── Event Subscription ──────────────────────────────

  /** Subscribe to server events (works in ALL tabs). Type-safe with EventMap. */
  on<K extends string & keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): Unsubscribe;
  on(event: string, handler: EventHandler<unknown>): Unsubscribe;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (data: any) => void): Unsubscribe {
    return this.subs.on(event, handler);
  }

  once<K extends string & keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): Unsubscribe;
  once(event: string, handler: EventHandler<unknown>): Unsubscribe;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string, handler: (data: any) => void): Unsubscribe {
    return this.subs.once(event, handler);
  }

  off(event: string, handler?: EventHandler): void {
    this.subs.off(event, handler);
  }

  /** Async generator for consuming events. Type-safe with EventMap. */
  stream<K extends string & keyof TEvents>(event: K, signal?: AbortSignal): AsyncGenerator<TEvents[K]>;
  stream(event: string, signal?: AbortSignal): AsyncGenerator<unknown>;
  stream(event: string, signal?: AbortSignal): AsyncGenerator<unknown> {
    return this.subs.stream(event, signal);
  }

  /** Send message to server (auto-routed through leader). Type-safe with EventMap. */
  send<K extends string & keyof TEvents>(event: K, data: TEvents[K]): void;
  send(event: string, data: unknown): void;
  send(event: string, data: unknown): void {
    // Per-event serializer transforms data before building payload
    const eventSerializer = this.serializers.get(event);
    const serializedData = eventSerializer ? eventSerializer(data) : data;

    let payload: unknown = { [this.proto.eventField]: event, [this.proto.dataField]: serializedData };

    for (const mw of this.outgoingMiddleware) {
      payload = mw(payload);
      if (payload === null) {
        this.log.debug('[SharedWS] ✗ outgoing dropped by middleware', event);
        return;
      }
    }

    this.log.debug('[SharedWS] → send', event, data);

    if (this.coordinator.isLeader && this.socket) {
      this.socket.send(payload);
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

  /**
   * Subscribe to a private/scoped channel. Returns a channel handle with
   * scoped on/send/stream methods. Sends join on subscribe, leave on unsubscribe.
   *
   * @example
   * const chat = ws.channel('chat:room_123');
   * chat.on('message', (msg) => render(msg));
   * chat.send('message', { text: 'Hello' });
   * chat.leave(); // sends leave + unsubscribes
   *
   * @example
   * // Private notifications for tenant
   * const notifications = ws.channel(`tenant:${tenantId}:notifications`);
   * notifications.on('alert', (alert) => showToast(alert));
   */
  channel(name: string): Channel {
    // Notify server about channel subscription
    this.send(this.proto.channelJoin, { channel: name });

    const self = this;
    const unsubs: Unsubscribe[] = [];

    return {
      name,
      on(event: string, handler: EventHandler): Unsubscribe {
        const unsub = self.subs.on(`${name}:${event}`, handler);
        unsubs.push(unsub);
        return unsub;
      },
      once(event: string, handler: EventHandler): Unsubscribe {
        const unsub = self.subs.once(`${name}:${event}`, handler);
        unsubs.push(unsub);
        return unsub;
      },
      send(event: string, data: unknown): void {
        self.send(`${name}:${event}`, data);
      },
      stream(event: string, signal?: AbortSignal): AsyncGenerator<unknown> {
        return self.subs.stream(`${name}:${event}`, signal);
      },
      leave(): void {
        self.send(self.proto.channelLeave, { channel: name });
        for (const unsub of unsubs) unsub();
        unsubs.length = 0;
      },
    };
  }

  // ─── Topics ──────────────────────────────────────────

  /**
   * Subscribe to a server-side topic. Server will start sending events for this topic.
   * Sends topicSubscribe event (default: "$topic:subscribe").
   *
   * @example
   * ws.subscribe('notifications:orders');
   * ws.subscribe('notifications:payments');
   * ws.subscribe(`user:${userId}:mentions`);
   */
  subscribe(topic: string): void {
    this.send(this.proto.topicSubscribe, { topic });
    this.log.debug('[SharedWS] 📌 subscribe topic', topic);
  }

  /**
   * Unsubscribe from a server-side topic.
   * Sends topicUnsubscribe event (default: "$topic:unsubscribe").
   */
  unsubscribe(topic: string): void {
    this.send(this.proto.topicUnsubscribe, { topic });
    this.log.debug('[SharedWS] 📌 unsubscribe topic', topic);
  }

  // ─── Push Notifications ─────────────────────────────

  /**
   * Subscribe to an event and show notifications.
   *
   * **target** controls which tab(s) display the notification:
   * - `'active'` — only the currently visible tab (default for render)
   * - `'leader'` — only the leader tab (default for browser Notification)
   * - `'all'` — every tab (for critical alerts)
   *
   * @example
   * // Custom render — sonner toast on active tab only
   * ws.push('notification', {
   *   render: (n) => toast(n.title),
   *   target: 'active',  // default for render
   * });
   *
   * @example
   * // Critical alert — show in ALL tabs
   * ws.push('payment.failed', {
   *   render: (n) => toast.error('Payment failed!'),
   *   target: 'all',
   * });
   *
   * @example
   * // Browser Notification — only from leader
   * ws.push('order.created', {
   *   title: (order) => `New Order #${order.id}`,
   *   target: 'leader',  // default for browser Notification
   * });
   *
   * @example
   * // Both render + native with different targets
   * ws.push('order.created', {
   *   render: (order) => toast(`Order #${order.id}`),  // active tab
   *   title: (order) => `New Order #${order.id}`,      // leader → native
   * });
   */
  push<T = unknown>(
    event: string,
    config: {
      /** Custom render function — you decide how to display. */
      render?: (data: T) => void;
      /** Title for browser Notification API. */
      title?: string | ((data: T) => string);
      /** Body for browser Notification API. */
      body?: string | ((data: T) => string);
      /** Icon URL for browser Notification. */
      icon?: string;
      /** Tag for browser Notification deduplication. */
      tag?: string | ((data: T) => string);
      /**
       * Which tab(s) show the notification:
       * - `'active'` — only the visible/focused tab (default for render)
       * - `'leader'` — only the leader tab (default for browser Notification)
       * - `'all'` — every tab (critical alerts)
       */
      target?: 'active' | 'leader' | 'all';
      /** Called when browser Notification is clicked. */
      onClick?: (data: T) => void;
    },
  ): Unsubscribe {
    const useNativeNotification = !!config.title;

    // Default target: 'active' for render, 'leader' for native
    const renderTarget = config.target ?? 'active';
    const nativeTarget = config.target ?? 'leader';

    if (useNativeNotification && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    return this.on(event, ((data: unknown) => {
      const typed = data as T;
      const isVisible = typeof document !== 'undefined' && !document.hidden;
      const isLeader = this.tabRole === 'leader';

      // Custom render
      if (config.render) {
        const shouldRender =
          renderTarget === 'all' ||
          (renderTarget === 'active' && isVisible) ||
          (renderTarget === 'leader' && isLeader);

        if (shouldRender) {
          config.render(typed);
          this.log.debug('[SharedWS] 🔔 render', event, `(target: ${renderTarget})`);
        }
      }

      // Browser Notification API
      if (useNativeNotification && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const shouldNotify =
          nativeTarget === 'all' ||
          (nativeTarget === 'leader' && isLeader) ||
          (nativeTarget === 'active' && isVisible);

        // Native notifications make sense when tab is hidden
        if (shouldNotify && !isVisible) {
          const title = typeof config.title === 'function' ? config.title(typed) : config.title!;
          const body = typeof config.body === 'function' ? config.body(typed) : config.body;
          const tag = typeof config.tag === 'function' ? config.tag(typed) : config.tag;

          const notif = new Notification(title, { body, icon: config.icon, tag });

          if (config.onClick) {
            const handler = config.onClick;
            notif.onclick = () => {
              handler(typed);
              window.focus();
            };
          }

          this.log.debug('[SharedWS] 🔔 native', title, `(target: ${nativeTarget})`);
        }
      }
    }) as EventHandler);
  }

  disconnect(): void {
    this[Symbol.dispose]();
  }

  private createSocket(): SocketAdapter {
    const socketOptions = {
      protocols: this.options.protocols,
      reconnect: this.options.reconnect,
      reconnectMaxDelay: this.options.reconnectMaxDelay,
      heartbeatInterval: this.options.heartbeatInterval,
      sendBuffer: this.options.sendBuffer,
      pingPayload: this.proto.ping,
    };

    if (this.options.useWorker) {
      // WebSocket runs in a Web Worker — main thread stays free
      return new WorkerSocket(this.url, {
        ...socketOptions,
        workerUrl: this.options.workerUrl,
      });
    }

    // WebSocket runs in main thread (default)
    return new SharedSocket(this.url, {
      ...socketOptions,
      auth: this.options.auth,
      authToken: this.options.authToken,
      authParam: this.options.authParam,
      serialize: this.options.serialize,
      deserialize: this.options.deserialize,
    });
  }

  private handleBecomeLeader(): void {
    this.log.info('[SharedWS] 👑 became leader');
    this.socket = this.createSocket();

    this.socket.onMessage((raw: unknown) => {
      let data: unknown = raw;
      for (const mw of this.incomingMiddleware) {
        data = mw(data);
        if (data === null) {
          this.log.debug('[SharedWS] ✗ incoming dropped by middleware');
          return;
        }
      }

      const msg = data as Record<string, unknown> | null | undefined;
      const event = (msg?.[this.proto.eventField] as string) ?? this.proto.defaultEvent;
      let payload = msg?.[this.proto.dataField] ?? data;

      // Per-event deserializer transforms data after global deserialize
      const eventDeserializer = this.deserializers.get(event);
      if (eventDeserializer) {
        payload = eventDeserializer(payload);
      }

      this.log.debug('[SharedWS] ← recv', event, payload);
      this.bus.broadcast('ws:message', { event, data: payload });
    });

    this.socket.onStateChange((state: string) => {
      this.log.info('[SharedWS]', state === 'connected' ? '✓ connected' : state === 'reconnecting' ? '🔄 reconnecting' : `state: ${state}`);
      switch (state) {
        case 'connected':
          this.bus.broadcast('ws:lifecycle', { type: 'connect' });
          break;
        case 'closed':
          this.bus.broadcast('ws:lifecycle', { type: 'disconnect' });
          break;
        case 'reconnecting':
          this.bus.broadcast('ws:lifecycle', { type: 'reconnecting' });
          break;
      }
    });

    this.cleanups.push(
      this.bus.respond<{ event: string; data: unknown }, unknown>('ws:request', async (req) => {
        return new Promise((resolve) => {
          const unsub = this.socket!.onMessage((response: unknown) => {
            const res = response as Record<string, unknown> | undefined;
            if (res?.[this.proto.eventField] === req.event || res?.requestId) {
              unsub();
              resolve(res?.[this.proto.dataField] ?? response);
            }
          });
          this.socket!.send({ event: req.event, data: req.data });
        });
      }),
    );

    this.socket.connect();
  }

  private handleLoseLeadership(): void {
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
