import './utils/disposable';
import { generateId } from './utils/id';
import { MessageBus } from './MessageBus';
import { TabCoordinator } from './TabCoordinator';
import { SharedSocket } from './SharedSocket';
import { WorkerSocket } from './WorkerSocket';
import { SubscriptionManager } from './SubscriptionManager';
import { FramePipeline } from './FramePipeline';
import { Outbox } from './Outbox';
import { BUS, LIFECYCLE, AUTH_TOKEN_KEY, WS_DEFAULTS, busSubsReply, MESSAGE_BUS_CHANNEL } from './constants';
import type { SharedWebSocketOptions, TabRole, Unsubscribe, EventHandler, Channel, EventProtocol, EventMap, Logger, Middleware, FrameKind, FramePayload, ChannelAckResult } from './types';

const DEFAULT_PROTOCOL: EventProtocol = {
  eventField: 'event',
  dataField: 'data',
  channelJoin: '$channel:join',
  channelLeave: '$channel:leave',
  ping: { type: 'ping' },
  defaultEvent: 'message',
  topicSubscribe: '$topic:subscribe',
  topicUnsubscribe: '$topic:unsubscribe',
  authLogin: '$auth:login',
  authLogout: '$auth:logout',
  authRevoked: '$auth:revoked',
};

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Internal separator for channel-scoped subscription keys. ASCII RECORD
 * SEPARATOR (U+001E) — chosen because it cannot collide with characters
 * users put in channel or event names. Wire format keeps `:` for server
 * compatibility; this is storage-only.
 */
const CHANNEL_KEY_SEP = '\u001e';

/** Common interface for both SharedSocket and WorkerSocket. */
interface SocketAdapter {
  readonly state: string;
  connect(): void | Promise<void>;
  send(data: unknown): void;
  reconnect(): void;
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
  /** Outgoing frame building + middleware + socket write. */
  private readonly framePipeline: FramePipeline;
  /** At-least-once buffer + replay for follower-originated dispatches. */
  private readonly outbox: Outbox;
  private incomingMiddleware: Middleware[] = [];
  private serializers = new Map<string, (data: unknown) => unknown>();
  private deserializers = new Map<string, (data: unknown) => unknown>();
  private _isAuthenticated = false;
  private authChannels = new Map<string, Channel>();
  private authTopics = new Set<string>();
  /**
   * Refcount of active channel subscriptions per name. Used to route
   * incoming events back to channel handlers via `${name}<RS>${event}`
   * keys without colliding when names/events contain `:`, and as the
   * source for cross-tab subscription replay on leader change.
   */
  private channelRefs = new Map<string, number>();
  /** All topic subscriptions (auth and non-auth). Replayed on leader change. */
  private topics = new Set<string>();
  /** Listeners for every raw incoming frame (post-deserialize, post-middleware). */
  private rawFrameListeners = new Set<(raw: unknown) => void>();
  /** Periodic refresh timer — leader only. Recreated on each leader handover. */
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Unsubscribe for the leader-only `ws:request` responder. Tracked separately
   * from `cleanups` so it can be torn down on EACH leadership loss — otherwise
   * a demoted tab keeps answering requests with a null socket, and every
   * re-promotion stacks another responder (duplicate server sends).
   */
  private requestResponderCleanup: Unsubscribe | null = null;

  constructor(
    private readonly url: string,
    private readonly options: SharedWebSocketOptions<TEvents> = {} as SharedWebSocketOptions<TEvents>,
  ) {
    this.proto = { ...DEFAULT_PROTOCOL, ...options.events };
    this.log = options.debug ? (options.logger ?? console) : NOOP_LOGGER;
    this.tabId = generateId();
    this.log.debug('[SharedWS] init', { tabId: this.tabId, url });
    this.bus = new MessageBus(MESSAGE_BUS_CHANNEL, this.tabId);
    this.coordinator = new TabCoordinator(this.bus, this.tabId, {
      electionTimeout: options.electionTimeout,
      heartbeatInterval: options.leaderHeartbeat,
      leaderTimeout: options.leaderTimeout,
      leaderPingTimeout: options.leaderPingTimeout,
    });

    // Outgoing pipeline + outbox. The outbox replays via the pipeline's
    // transmit, which writes to whatever socket the pipeline currently holds.
    this.framePipeline = new FramePipeline(this.proto, this.log);
    this.outbox = new Outbox(
      this.bus,
      options.outboundBufferSize ?? WS_DEFAULTS.OUTBOUND_BUFFER_SIZE,
      (kind, payload) => this.framePipeline.transmit(kind, payload),
      this.log,
    );

    // Let the coordinator decide leader health from real socket state — a
    // backgrounded leader with a dead socket fails this check and is taken
    // over by the next active tab instead of clinging to leadership.
    this.coordinator.setHealthCheck(() => this.socket?.state === 'connected');

    // If self-verification finds this tab is leader with a dead socket,
    // reconnect rather than hand off — we already own the socket.
    this.cleanups.push(
      this.coordinator.onLeaderUnhealthy(() => {
        this.log.warn('[SharedWS] leader socket unhealthy on activate — reconnecting');
        this.socket?.reconnect();
      }),
    );

    // When ANY tab receives a WS message via bus → emit to local subscribers
    this.cleanups.push(
      this.bus.subscribe<{ event: string; data: unknown; raw?: unknown }>(BUS.MESSAGE, (msg) => {
        // Bare emit — fires any handler registered with the literal event name
        this.subs.emit(msg.event, msg.data, msg.raw);

        // Channel-scoped emit — for each registered channel whose name is a
        // prefix of the incoming event (separated by ':'), also fire handlers
        // stored under `${name}<RS>${rest}`. This lets `Channel.on('msg', h)`
        // receive a wire event like 'chat:room:42:msg' without colon parsing.
        for (const channelName of this.channelRefs.keys()) {
          const prefix = channelName + ':';
          if (msg.event.length > prefix.length && msg.event.startsWith(prefix)) {
            const subEvent = msg.event.slice(prefix.length);
            this.subs.emit(`${channelName}${CHANNEL_KEY_SEP}${subEvent}`, msg.data, msg.raw);
          }
        }

        // Raw-frame fanout — pending Channel.ready ack matchers listen here.
        if (this.rawFrameListeners.size > 0) {
          for (const fn of this.rawFrameListeners) {
            try { fn(msg.raw); } catch { /* matcher errors don't break dispatch */ }
          }
        }
      }),
    );

    // Leader listens for dispatch requests from followers — re-enters
    // transmit() so frameBuilder + outgoing middleware run on the tab that
    // actually owns the socket.
    this.cleanups.push(
      this.bus.subscribe<{ kind: FrameKind; payload: FramePayload; id?: string }>(BUS.DISPATCH, (msg) => {
        if (this.coordinator.isLeader && this.socket) {
          this.framePipeline.transmit(msg.kind, msg.payload);
          // Tell the originator to drop the entry from its pending buffer.
          // Always flush — even when transmit was a no-op (middleware drop,
          // frameBuilder returned null) — there's no point retrying a
          // permanently-dropped frame.
          if (msg.id) this.bus.publish(BUS.DISPATCH_FLUSHED, { id: msg.id });
        }
      }),
    );
    // The originator-side flush handler and pending-gather responder live in
    // Outbox (it owns the buffer those operate on).

    // Leader listens for reconnect requests from followers
    this.cleanups.push(
      this.bus.subscribe<void>(BUS.RECONNECT, () => {
        if (this.coordinator.isLeader && this.socket) {
          this.log.info('[SharedWS] manual reconnect requested by follower');
          this.socket.reconnect();
        }
      }),
    );

    // Conditional resume — only reconnect if the leader's socket gave up
    // (e.g. auth-failure close code). Sent by authenticate() from followers
    // so they can recover with fresh creds without disrupting healthy tabs.
    this.cleanups.push(
      this.bus.subscribe<void>(BUS.AUTH_RESUME, () => {
        if (this.coordinator.isLeader && this.socket?.state === 'failed') {
          this.log.info('[SharedWS] resume requested after auth — reconnecting failed socket');
          this.socket.reconnect();
        }
      }),
    );

    // Each tab announces its channels/topics on request. Used on leader
    // promotion or reconnect to rebuild the server-side subscription set.
    this.cleanups.push(
      this.bus.subscribe<{ replyId: string }>(BUS.GATHER_SUBS, (req) => {
        this.bus.publish(busSubsReply(req.replyId), {
          channels: [...this.channelRefs.keys()],
          topics: [...this.topics],
        });
      }),
    );

    // Sync across tabs
    this.cleanups.push(
      this.bus.subscribe<{ key: string; value: unknown }>(BUS.SYNC, (msg) => {
        this.syncStore.set(msg.key, msg.value);
        this.subs.emit(`sync:${msg.key}`, msg.value);
      }),
    );

    // Leader lifecycle
    this.coordinator.onBecomeLeader(() => {
      this.handleBecomeLeader();
      this.bus.broadcast(BUS.LIFECYCLE, { type: 'leader', isLeader: true });
    });
    this.coordinator.onLoseLeadership(() => {
      this.handleLoseLeadership();
      this.bus.broadcast(BUS.LIFECYCLE, { type: 'leader', isLeader: false });
    });

    // Lifecycle events from bus (all tabs receive)
    this.cleanups.push(
      this.bus.subscribe<{ type: string; isLeader?: boolean; error?: unknown; authenticated?: boolean }>(BUS.LIFECYCLE, (msg) => {
        switch (msg.type) {
          case 'connect':
            this.subs.emit(LIFECYCLE.CONNECT, undefined);
            break;
          case 'disconnect':
            this.subs.emit(LIFECYCLE.DISCONNECT, undefined);
            break;
          case 'reconnecting':
            this.subs.emit(LIFECYCLE.RECONNECTING, undefined);
            break;
          case 'reconnectFailed':
            this.subs.emit(LIFECYCLE.RECONNECT_FAILED, undefined);
            break;
          case 'leader':
            this.subs.emit(LIFECYCLE.LEADER, msg.isLeader);
            break;
          case 'error':
            this.subs.emit(LIFECYCLE.ERROR, msg.error);
            break;
          case 'auth': {
            this._isAuthenticated = !!msg.authenticated;
            if (!msg.authenticated) {
              this.authChannels.clear();
              this.authTopics.clear();
            }
            this.subs.emit(LIFECYCLE.AUTH, msg.authenticated);
            break;
          }
        }
      }),
    );

    // Track tab visibility
    if (typeof document !== 'undefined') {
      const onVisibilityChange = () => {
        const active = !document.hidden;
        this.subs.emit(LIFECYCLE.ACTIVE, active);
        this.log.debug('[SharedWS]', active ? '👁 tab active' : '👁 tab hidden');
        // On re-activation, make sure the leader (and its socket) survived
        // the idle period; take over if it didn't. Opt-out via recoverOnActivate.
        if (active && (this.options.recoverOnActivate ?? true)) {
          void this.coordinator.verifyLeader();
        }
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      this.cleanups.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));
    }

    // Handle server-initiated auth revocation
    this.cleanups.push(
      this.subs.on(this.proto.authRevoked, () => {
        if (this.coordinator.isLeader) {
          for (const [, ch] of this.authChannels) ch.leave();
          for (const topic of this.authTopics) this.unsubscribe(topic);
        }
        this.authChannels.clear();
        this.authTopics.clear();
        this._isAuthenticated = false;
        this.syncStore.delete(AUTH_TOKEN_KEY);
        this.subs.emit(LIFECYCLE.AUTH, false);
        this.log.warn('[SharedWS] auth revoked by server');
      }),
    );

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

  /** Whether the user is authenticated via runtime auth. */
  get isAuthenticated(): boolean {
    return this._isAuthenticated;
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
    return this.subs.on(LIFECYCLE.CONNECT, fn);
  }

  /** Called when WebSocket connection closes (broadcast to all tabs). */
  onDisconnect(fn: () => void): Unsubscribe {
    return this.subs.on(LIFECYCLE.DISCONNECT, fn);
  }

  /** Called when WebSocket starts reconnecting (broadcast to all tabs). */
  onReconnecting(fn: () => void): Unsubscribe {
    return this.subs.on(LIFECYCLE.RECONNECTING, fn);
  }

  /**
   * Called when auto-reconnect gives up after exhausting `reconnectMaxRetries`.
   * Use this to show a "Reconnect" UI affordance (snackbar, banner, modal)
   * so the user can call `ws.reconnect()` to try again.
   *
   * @example
   * ws.onReconnectFailed(() => {
   *   showSnackbar('Connection lost', { action: { label: 'Reconnect', onClick: () => ws.reconnect() } });
   * });
   */
  onReconnectFailed(fn: () => void): Unsubscribe {
    return this.subs.on(LIFECYCLE.RECONNECT_FAILED, fn);
  }

  /**
   * Manually trigger a reconnect. Resets the retry counter and attempts a
   * fresh connection. Safe to call from any tab — the leader actually owns
   * the socket, followers route the request via BroadcastChannel.
   *
   * Use after `onReconnectFailed` fires to let the user retry.
   *
   * @example
   * snackbar.action('Reconnect', () => ws.reconnect());
   */
  reconnect(): void {
    if (this.coordinator.isLeader && this.socket) {
      this.socket.reconnect();
    } else {
      this.bus.publish(BUS.RECONNECT, undefined);
    }
  }

  /** Called when this tab becomes leader or loses leadership. */
  onLeaderChange(fn: (isLeader: boolean) => void): Unsubscribe {
    return this.subs.on(LIFECYCLE.LEADER, fn as EventHandler);
  }

  /** Called on WebSocket or network error (broadcast to all tabs). */
  onError(fn: (error: unknown) => void): Unsubscribe {
    return this.subs.on(LIFECYCLE.ERROR, fn as EventHandler);
  }

  /** Called when this tab becomes visible/focused. */
  onActive(fn: () => void): Unsubscribe {
    return this.subs.on(LIFECYCLE.ACTIVE, ((isActive: unknown) => {
      if (isActive === true) fn();
    }) as EventHandler);
  }

  /** Called when this tab goes to background/hidden. */
  onInactive(fn: () => void): Unsubscribe {
    return this.subs.on(LIFECYCLE.ACTIVE, ((isActive: unknown) => {
      if (isActive === false) fn();
    }) as EventHandler);
  }

  /** Called on any visibility change. */
  onVisibilityChange(fn: (isActive: boolean) => void): Unsubscribe {
    return this.subs.on(LIFECYCLE.ACTIVE, fn as EventHandler);
  }

  // ─── Authentication ──────────────────────────────────

  /**
   * Authenticate on an existing connection. Sends auth event to server,
   * syncs auth state across all tabs. Use for login after guest connection.
   *
   * @example
   * const token = await loginApi(email, password);
   * ws.authenticate(token);
   *
   * @example
   * // React — via useSocketAuth hook
   * const { authenticate } = useSocketAuth();
   * authenticate(token);
   */
  authenticate(token: string): void {
    this._isAuthenticated = true;
    this.syncStore.set(AUTH_TOKEN_KEY, token);
    this.bus.broadcast(BUS.SYNC, { key: AUTH_TOKEN_KEY, value: token });
    this.bus.broadcast(BUS.LIFECYCLE, { type: 'auth', authenticated: true });
    this.log.info('[SharedWS] authenticated');

    // If the leader's socket gave up (e.g. auth-failure close code), the new
    // creds should restart the connection. resubscribeOnConnect resends
    // the auth-login frame from syncStore once we're connected again.
    if (this.coordinator.isLeader && this.socket && this.socket.state === 'failed') {
      this.reconnect();
      return;
    }

    if (!this.coordinator.isLeader) {
      // Followers can't see leader state — hint to leader to reconnect IFF failed.
      this.bus.publish(BUS.AUTH_RESUME, undefined);
    }

    this.dispatch('auth-login', { data: token });
  }

  /**
   * Deauthenticate — notifies server, auto-leaves all auth-required channels
   * and topics, syncs state across tabs. Connection stays open for public events.
   *
   * @example
   * ws.deauthenticate(); // connection stays open, auth subscriptions cleaned up
   */
  deauthenticate(): void {
    // Leave auth channels and unsubscribe auth topics
    for (const [, ch] of this.authChannels) ch.leave();
    this.authChannels.clear();
    for (const topic of this.authTopics) this.unsubscribe(topic);
    this.authTopics.clear();

    this._isAuthenticated = false;
    this.dispatch('auth-logout', {});
    this.syncStore.delete(AUTH_TOKEN_KEY);
    this.bus.broadcast(BUS.SYNC, { key: AUTH_TOKEN_KEY, value: undefined });
    this.bus.broadcast(BUS.LIFECYCLE, { type: 'auth', authenticated: false });
    this.log.info('[SharedWS] deauthenticated');
  }

  /**
   * Called when auth state changes (authenticate, deauthenticate, or server revocation).
   *
   * @example
   * ws.onAuthChange((authenticated) => {
   *   if (!authenticated) router.push('/login');
   * });
   */
  onAuthChange(fn: (authenticated: boolean) => void): Unsubscribe {
    return this.subs.on(LIFECYCLE.AUTH, fn as EventHandler);
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
      this.framePipeline.use(fn);
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

  /**
   * Subscribe to server events (works in ALL tabs). Type-safe with EventMap.
   *
   * The handler receives `(data, raw)`:
   * - `data` is extracted via `dataField` (default `'data'`)
   * - `raw` is the full deserialized envelope, useful for protocols with extra
   *   top-level fields like `id`, `kind`, `channel`, `type`, etc.
   *
   * @example
   * ws.on('msg', (data, raw) => {
   *   raw.id;    // top-level metadata
   *   raw.kind;  // discriminator
   * });
   */
  on<K extends string & keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): Unsubscribe;
  on(event: string, handler: EventHandler<unknown>): Unsubscribe;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (data: any, raw?: unknown) => void): Unsubscribe {
    return this.subs.on(event, handler);
  }

  once<K extends string & keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): Unsubscribe;
  once(event: string, handler: EventHandler<unknown>): Unsubscribe;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string, handler: (data: any, raw?: unknown) => void): Unsubscribe {
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

  /**
   * Send message to server (auto-routed through leader). Type-safe with EventMap.
   *
   * The optional third argument `extras` adds top-level fields to the wire envelope.
   * Use it for protocols that need extra envelope keys like `type`, `channel`, etc.
   *
   * @example
   * // Default shape: { event, data }
   * ws.send('chat.message', { text: 'Hello' });
   * // → { event: 'chat.message', data: { text: 'Hello' } }
   *
   * @example
   * // Pusher/Reverb-style envelope
   * ws.send('group.member_ready',
   *   { member_id: 'abc', ready: true },
   *   { type: 'event', channel: 'public.group.xxx' },
   * );
   * // → {
   * //     type: 'event',
   * //     channel: 'public.group.xxx',
   * //     event: 'group.member_ready',
   * //     data: { member_id: 'abc', ready: true },
   * //   }
   */
  send<K extends string & keyof TEvents>(event: K, data: TEvents[K], extras?: Record<string, unknown>): void;
  send(event: string, data: unknown, extras?: Record<string, unknown>): void;
  send(event: string, data: unknown, extras?: Record<string, unknown>): void {
    this.assertExtrasReserved(extras);

    // Per-event serializer transforms data before the frame is built
    const eventSerializer = this.serializers.get(event);
    const serializedData = eventSerializer ? eventSerializer(data) : data;

    this.dispatch('event', { event, data: serializedData, extras });
  }

  private assertExtrasReserved(extras: Record<string, unknown> | undefined): void {
    if (!extras) return;
    if (this.proto.eventField in extras) {
      throw new Error(
        `SharedWebSocket.send: extras cannot contain reserved key "${this.proto.eventField}" (eventField). ` +
          `Pass the event name as the first argument instead.`,
      );
    }
    if (this.proto.dataField in extras) {
      throw new Error(
        `SharedWebSocket.send: extras cannot contain reserved key "${this.proto.dataField}" (dataField). ` +
          `Pass the payload as the second argument instead.`,
      );
    }
  }

  /** Request/response through server via leader. */
  async request<T>(event: string, data: unknown, timeout = WS_DEFAULTS.REQUEST_TIMEOUT): Promise<T> {
    // If THIS tab owns the socket, answer locally. Routing through the bus
    // would dead-end: `bus.respond` ignores requests from its own tabId, so a
    // leader calling request() would never get a response and always time out.
    if (this.coordinator.isLeader && this.socket) {
      return this.performRequest(event, data, timeout) as Promise<T>;
    }
    return this.bus.request(BUS.REQUEST, { event, data, timeout }, timeout);
  }

  /**
   * Leader-side request/response over the live socket. Sends the event, then
   * resolves with the first matching response frame (matched by event name or
   * a `requestId` field), or rejects on timeout. Used by both the local
   * `request()` fast-path and the `ws:request` responder for followers.
   */
  private performRequest(event: string, data: unknown, timeout: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket) {
        reject(new Error('SharedWebSocket.request: no socket on leader'));
        return;
      }
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        fn();
      };
      const unsub = socket.onMessage((response: unknown) => {
        const res = response as Record<string, unknown> | undefined;
        if (res?.[this.proto.eventField] === event || res?.requestId) {
          finish(() => resolve(res?.[this.proto.dataField] ?? response));
        }
      });
      const timer = setTimeout(
        () => finish(() => reject(new Error(`SharedWebSocket.request: timeout for "${event}"`))),
        timeout,
      );
      this.framePipeline.transmit('event', { event, data });
    });
  }

  /** Sync state across tabs (no server roundtrip). */
  sync<T>(key: string, value: T): void {
    this.syncStore.set(key, value);
    this.bus.broadcast(BUS.SYNC, { key, value });
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
  channel(name: string, options?: { auth?: boolean }): Channel {
    // Set up the ack matcher BEFORE dispatching so we don't miss a fast
    // server response. With no matcher configured, ready resolves
    // synchronously on the next microtask after dispatch.
    const matcher = this.proto.channelAckMatcher;
    const ackTimeout = this.proto.channelAckTimeout ?? WS_DEFAULTS.CHANNEL_ACK_TIMEOUT;
    let cancelReady: ((reason: Error) => void) | undefined;

    const ready = matcher
      ? new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubAck();
            fn();
          };
          const unsubAck = this.onRawFrame((frame) => {
            let result: ChannelAckResult;
            try {
              result = matcher(frame, name);
            } catch {
              // matcher exceptions are treated as a hard reject
              result = 'reject';
            }
            if (result === 'ok') settle(() => resolve());
            else if (result === 'reject') settle(() => reject(new Error(`SharedWebSocket: subscribe rejected for channel "${name}"`)));
          });
          const timer = setTimeout(
            () => settle(() => reject(new Error(`SharedWebSocket: subscribe ack timeout for channel "${name}"`))),
            ackTimeout,
          );
          cancelReady = (err: Error) => settle(() => reject(err));
        })
      : Promise.resolve();

    // Avoid noisy unhandled-rejection warnings if the user never awaits ready.
    if (matcher) ready.catch(() => {});

    // Notify server about channel subscription
    this.dispatch('subscribe', { channel: name });

    // Track this channel for incoming-event prefix routing
    this.channelRefs.set(name, (this.channelRefs.get(name) ?? 0) + 1);

    const self = this;
    const unsubs: Unsubscribe[] = [];
    const isAuth = options?.auth ?? false;
    let left = false;
    const key = (event: string) => `${name}${CHANNEL_KEY_SEP}${event}`;

    const ch: Channel = {
      name,
      ready,
      on(event: string, handler: EventHandler): Unsubscribe {
        const unsub = self.subs.on(key(event), handler);
        unsubs.push(unsub);
        return unsub;
      },
      once(event: string, handler: EventHandler): Unsubscribe {
        const unsub = self.subs.once(key(event), handler);
        unsubs.push(unsub);
        return unsub;
      },
      send(event: string, data: unknown): void {
        // Channel name is passed structurally so a custom frameBuilder can
        // emit it as a top-level wire field (Pusher/Reverb-style). The
        // default builder joins as `${channel}:${event}` for back-compat.
        // Per-event serializers are keyed on the joined name (legacy).
        const joined = `${name}:${event}`;
        const eventSerializer = self.serializers.get(joined) ?? self.serializers.get(event);
        const serializedData = eventSerializer ? eventSerializer(data) : data;
        self.dispatch('event', { event, data: serializedData, channel: name });
      },
      stream(event: string, signal?: AbortSignal): AsyncGenerator<unknown> {
        return self.subs.stream(key(event), signal);
      },
      leave(): void {
        if (left) return;
        left = true;
        cancelReady?.(new Error(`SharedWebSocket: channel "${name}" left before ack`));
        self.dispatch('unsubscribe', { channel: name });
        for (const unsub of unsubs) unsub();
        unsubs.length = 0;
        if (isAuth) self.authChannels.delete(name);
        const next = (self.channelRefs.get(name) ?? 1) - 1;
        if (next <= 0) self.channelRefs.delete(name);
        else self.channelRefs.set(name, next);
      },
    };

    if (isAuth) {
      this.authChannels.set(name, ch);
    }

    return ch;
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
  subscribe(topic: string, options?: { auth?: boolean }): void {
    this.dispatch('topic-subscribe', { topic });
    this.topics.add(topic);
    if (options?.auth) {
      this.authTopics.add(topic);
    }
    this.log.debug('[SharedWS] subscribe topic', topic);
  }

  /**
   * Unsubscribe from a server-side topic.
   * Sends topicUnsubscribe event (default: "$topic:unsubscribe").
   */
  unsubscribe(topic: string): void {
    this.dispatch('topic-unsubscribe', { topic });
    this.topics.delete(topic);
    this.authTopics.delete(topic);
    this.log.debug('[SharedWS] unsubscribe topic', topic);
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

  // ─── Frame Pipeline ─────────────────────────────────
  //
  // dispatch(kind, payload) is the single entry point for all outgoing
  // frames (events, channel join/leave, topic sub/unsub, auth login/logout).
  // - On the leader, it calls transmit() which builds the frame, runs
  //   outgoing middleware, and writes to the socket.
  // - On followers, it forwards { kind, payload } over BroadcastChannel;
  //   the leader's bus subscriber re-enters transmit() so middleware
  //   runs in exactly one place regardless of which tab originated.
  //
  // The actual wire shape is decided by frameBuilder (custom) or
  // defaultFrameBuilder (legacy two-key { event, data } envelope).

  /**
   * Subscribe to every raw incoming frame (post-deserialize). Used by
   * `Channel.ready`'s ack matcher. Internal — not part of the public API.
   */
  private onRawFrame(fn: (raw: unknown) => void): Unsubscribe {
    this.rawFrameListeners.add(fn);
    return () => { this.rawFrameListeners.delete(fn); };
  }

  /**
   * Route a structured frame: the leader transmits directly via the frame
   * pipeline; followers hand it to the outbox, which buffers (event kinds) and
   * forwards over the bus for the leader to write.
   */
  private dispatch(kind: FrameKind, payload: FramePayload): void {
    if (this.coordinator.isLeader && this.socket) {
      this.framePipeline.transmit(kind, payload);
      return;
    }
    this.outbox.route(kind, payload);
  }

  private createSocket(): SocketAdapter {
    const socketOptions = {
      protocols: this.options.protocols,
      reconnect: this.options.reconnect,
      reconnectMaxDelay: this.options.reconnectMaxDelay,
      reconnectMaxRetries: this.options.reconnectMaxRetries,
      authFailureCloseCodes: this.options.authFailureCloseCodes,
      heartbeatInterval: this.options.heartbeatInterval,
      heartbeatTimeout: this.options.heartbeatTimeout,
      sendBuffer: this.options.sendBuffer,
      pingPayload: this.proto.ping,
    };

    if (this.options.useWorker) {
      // WebSocket runs in a Web Worker — main thread stays free
      return new WorkerSocket(this.url, {
        ...socketOptions,
        workerUrl: this.options.workerUrl,
        auth: this.options.auth,
        authToken: this.options.authToken,
        authParam: this.options.authParam,
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
    this.framePipeline.setSocket(this.socket);
    this.startRefreshTimer();

    this.socket.onMessage((raw: unknown) => {
      let data: unknown = raw;
      for (const mw of this.incomingMiddleware) {
        data = mw(data);
        if (data === null) {
          this.log.debug('[SharedWS] ✗ incoming dropped by middleware', { raw });
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

      this.log.debug('[SharedWS] ← recv', event, { data: payload, raw: data });
      this.bus.broadcast(BUS.MESSAGE, { event, data: payload, raw: data });
    });

    this.socket.onStateChange((state: string) => {
      this.log.info('[SharedWS]', state === 'connected' ? '✓ connected' : state === 'reconnecting' ? '🔄 reconnecting' : state === 'failed' ? '✗ reconnect failed' : `state: ${state}`);
      switch (state) {
        case 'connected':
          this.bus.broadcast(BUS.LIFECYCLE, { type: 'connect' });
          void this.onConnected();
          break;
        case 'closed':
          this.bus.broadcast(BUS.LIFECYCLE, { type: 'disconnect' });
          break;
        case 'reconnecting':
          this.bus.broadcast(BUS.LIFECYCLE, { type: 'reconnecting' });
          break;
        case 'failed':
          this.bus.broadcast(BUS.LIFECYCLE, { type: 'reconnectFailed' });
          this.bus.broadcast(BUS.LIFECYCLE, { type: 'disconnect' });
          break;
      }
    });

    // Replace any stale responder from a previous promotion, then register a
    // fresh one bound to the new socket. Stored outside `cleanups` so it's torn
    // down on leadership loss (see handleLoseLeadership).
    this.requestResponderCleanup?.();
    this.requestResponderCleanup = this.bus.respond<{ event: string; data: unknown; timeout?: number }, unknown>(
      BUS.REQUEST,
      // Swallow a rejection (timeout / no socket) to undefined: the follower
      // that asked has its own bus.request timeout and will have given up, so
      // the late response is dropped anyway. Avoids an unhandled rejection.
      (req) => this.performRequest(req.event, req.data, req.timeout ?? WS_DEFAULTS.REQUEST_TIMEOUT).catch(() => undefined),
    );

    void this.socket.connect();
  }

  /**
   * Re-establish all server-side state on the freshly connected leader socket:
   *   1. auth-login (so server accepts subsequent joins on auth channels)
   *   2. channel-join for the union of channels held by ALL surviving tabs
   *   3. topic-subscribe for the union of topics held by ALL surviving tabs
   *
   * The union covers leader handover: when a follower with handlers is
   * promoted, no tab's subscriptions get silently dropped. Frames are sent
   * in FIFO order over the single WebSocket, so auth precedes the joins
   * that depend on it.
   */
  /**
   * Orchestrate post-connect recovery: replay subscriptions first (so the
   * server is ready to route events for any channels we still care about),
   * then drain follower-pending dispatches that didn't reach the previous
   * leader's socket.
   */
  private async onConnected(): Promise<void> {
    await this.resubscribeOnConnect();
    // Drain follower-pending dispatches that didn't reach the previous leader.
    // Bail if leadership/socket changed again while the outbox was gathering.
    const socket = this.socket;
    await this.outbox.replay(() => this.socket === socket);
  }

  private async resubscribeOnConnect(): Promise<void> {
    if (!this.socket) return;
    const socket = this.socket;

    // 1. Re-authenticate first so subsequent auth-channel joins succeed.
    if (this._isAuthenticated) {
      const token = this.syncStore.get(AUTH_TOKEN_KEY) as string | undefined;
      if (token) {
        this.framePipeline.transmit('auth-login', { data: token });
        this.log.debug('[SharedWS] re-authenticated after reconnect');
      }
    }

    // 2/3. Gather subscriptions from all surviving tabs (including self).
    const { channels, topics } = await this.gatherSubscriptions();
    if (this.socket !== socket) return; // socket replaced while we were waiting

    for (const name of channels) {
      this.framePipeline.transmit('subscribe', { channel: name });
    }
    for (const topic of topics) {
      this.framePipeline.transmit('topic-subscribe', { topic });
    }

    if (channels.length || topics.length) {
      this.log.info('[SharedWS] replayed subscriptions', {
        channels: channels.length,
        topics: topics.length,
      });
    }
  }

  /**
   * Best-effort cross-tab gather. Broadcasts a request and collects responses
   * for a short window. Times out gracefully — late responses are dropped.
   * The leader's own subs are seeded into the result to avoid relying on
   * BroadcastChannel echo to self.
   */
  private gatherSubscriptions(timeoutMs: number = WS_DEFAULTS.GATHER_SUBS_TIMEOUT): Promise<{ channels: string[]; topics: string[] }> {
    const channels = new Set<string>(this.channelRefs.keys());
    const topics = new Set<string>(this.topics);
    const replyId = generateId();

    return new Promise((resolve) => {
      const unsub = this.bus.subscribe<{ channels: string[]; topics: string[] }>(
        busSubsReply(replyId),
        (msg) => {
          for (const c of msg.channels) channels.add(c);
          for (const t of msg.topics) topics.add(t);
        },
      );

      this.bus.publish(BUS.GATHER_SUBS, { replyId });

      setTimeout(() => {
        unsub();
        resolve({ channels: [...channels], topics: [...topics] });
      }, timeoutMs);
    });
  }

  private handleLoseLeadership(): void {
    this.stopRefreshTimer();
    this.requestResponderCleanup?.();
    this.requestResponderCleanup = null;
    if (this.socket) {
      this.socket[Symbol.dispose]();
      this.socket = null;
    }
    this.framePipeline.setSocket(null);
  }

  /**
   * Start a leader-only periodic refresh of the auth token. The callback
   * is `options.refresh` (preferred) or `options.auth` (fallback). When
   * the timer fires and the connection is currently authenticated, the
   * returned token is fed back through `authenticate()` so subscribers
   * stay synced and the leader's socket re-issues auth-login.
   *
   * Idempotent — calling start while already running is a no-op.
   */
  private startRefreshTimer(): void {
    if (this.refreshTimer) return;
    const interval = this.options.refreshTokenInterval;
    const refresh = this.options.refresh ?? this.options.auth;
    if (!interval || interval <= 0 || !refresh) return;
    if (!this.coordinator.isLeader) return;

    this.refreshTimer = setInterval(async () => {
      if (!this.coordinator.isLeader || !this._isAuthenticated) return;
      try {
        const token = await refresh();
        if (!token) {
          this.log.warn('[SharedWS] refresh() returned empty token — skipping');
          return;
        }
        this.authenticate(token);
      } catch (err) {
        this.log.warn('[SharedWS] refresh() failed', err);
      }
    }, interval);
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRefreshTimer();
    this.requestResponderCleanup?.();
    this.requestResponderCleanup = null;

    this.coordinator[Symbol.dispose]();
    this.outbox[Symbol.dispose]();
    this.framePipeline.setSocket(null);

    if (this.socket) {
      this.socket[Symbol.dispose]();
      this.socket = null;
    }

    for (const unsub of this.cleanups) unsub();
    this.cleanups = [];
    this.subs[Symbol.dispose]();
    this.bus[Symbol.dispose]();
    this.syncStore.clear();
    this.authChannels.clear();
    this.authTopics.clear();
    this.channelRefs.clear();
    this.topics.clear();
    this.rawFrameListeners.clear();
  }
}
