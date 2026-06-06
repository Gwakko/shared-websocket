export type SocketState = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'failed';
export type TabRole = 'leader' | 'follower';
export type Unsubscribe = () => void;
/**
 * Event handler. Receives the extracted `data` (per `dataField`) plus the
 * full raw envelope as a second argument. Use `raw` to access top-level
 * fields outside `dataField` (e.g. `id`, `kind`, `channel`, `type`).
 */
export type EventHandler<T = unknown> = (data: T, raw?: unknown) => void;

/** Type-safe event map. Keys are event names, values are payload types. */
export type EventMap = Record<string, unknown>;

export interface BusMessage {
  id: string;
  source: string;
  topic: string;
  type: 'publish' | 'request' | 'response' | 'broadcast';
  data: unknown;
  timestamp: number;
}

/**
 * Logger interface — inject your own logger (console, pino, winston, Sentry).
 *
 * @example
 * // Default: console
 * { logger: console }
 *
 * @example
 * // Sentry breadcrumbs
 * {
 *   logger: {
 *     debug: (msg, ...args) => Sentry.addBreadcrumb({ message: msg, data: args, level: 'debug' }),
 *     info:  (msg, ...args) => Sentry.addBreadcrumb({ message: msg, data: args, level: 'info' }),
 *     warn:  (msg, ...args) => Sentry.addBreadcrumb({ message: msg, data: args, level: 'warning' }),
 *     error: (msg, ...args) => Sentry.captureException(args[0] ?? new Error(msg)),
 *   }
 * }
 *
 * @example
 * // Pino
 * import pino from 'pino';
 * { logger: pino({ name: 'shared-ws' }) }
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Middleware function — transform or inspect messages. Return null to drop. */
export type Middleware<T = unknown> = (message: T) => T | null;

/**
 * Kinds of frames the library emits. Lets `EventProtocol.frameBuilder`
 * take full control over the wire shape per kind — e.g. produce flat
 * `{ type, channel, event, data }` envelopes for Pusher/Reverb/custom
 * servers instead of the default `{ event, data }` two-key wrapper.
 */
export type FrameKind =
  | 'event'              // user payload via ws.send / Channel.send
  | 'subscribe'          // channel join
  | 'unsubscribe'        // channel leave
  | 'topic-subscribe'    // topic subscribe
  | 'topic-unsubscribe'  // topic unsubscribe
  | 'auth-login'         // authenticate(token)
  | 'auth-logout';       // deauthenticate()

/**
 * Structured payload passed to `frameBuilder`. Fields are populated
 * based on `kind`:
 *
 *   - `event`              → `{ event, data, channel?, extras? }`
 *                            `channel` is set when sent via `Channel.send`.
 *   - `subscribe`/`unsubscribe`        → `{ channel, extras? }`
 *   - `topic-subscribe`/`topic-unsubscribe` → `{ topic, extras? }`
 *   - `auth-login`         → `{ data: token, extras? }` (`data` is the raw token)
 *   - `auth-logout`        → `{ extras? }`
 */
export interface FramePayload {
  /** Channel name. Set for subscribe/unsubscribe and channel-scoped events. */
  channel?: string;
  /** Topic name. Set for topic-subscribe/topic-unsubscribe. */
  topic?: string;
  /** Bare event name (without channel prefix). Set for `kind: 'event'`. */
  event?: string;
  /** Payload — user data, auth token, etc. */
  data?: unknown;
  /** Extra top-level fields to merge into the wire envelope. */
  extras?: Record<string, unknown>;
}

export interface SharedWebSocketOptions<TEvents extends EventMap = EventMap> {
  protocols?: string[];
  reconnect?: boolean;
  reconnectMaxDelay?: number;
  /** Max reconnect attempts before giving up (default: Infinity — retry forever). */
  reconnectMaxRetries?: number;
  /**
   * WebSocket close codes that indicate "auth failed — don't retry."
   * On these codes the library sets state to 'failed' and stops auto-reconnect
   * instead of looping with the same expired credentials. Default: `[1008]`
   * (PolicyViolation). Add 4xxx app-specific codes if your server uses them.
   *
   * To recover, call `ws.authenticate(newToken)` (auto-reconnects when
   * the local tab is the leader) or `ws.reconnect()` directly.
   */
  authFailureCloseCodes?: number[];
  heartbeatInterval?: number;
  electionTimeout?: number;
  leaderHeartbeat?: number;
  leaderTimeout?: number;
  /**
   * When a tab becomes visible again after being idle, ping the current
   * leader and re-elect this tab if no healthy leader answers within this
   * window (ms). Guards against the case where a backgrounded leader's
   * timers were throttled and its socket silently died, so followers never
   * saw the heartbeat lapse and the connection stayed stuck. Default: 1500.
   */
  leaderPingTimeout?: number;
  /**
   * Verify the leader (and take over if it's unresponsive) whenever this tab
   * becomes active again. Set to `false` to disable the active-tab recovery
   * and rely solely on heartbeat timeout. Default: `true`.
   */
  recoverOnActivate?: boolean;
  sendBuffer?: number;
  /** Auth token provider — called before each connect/reconnect. */
  auth?: () => string | Promise<string>;
  /** Static auth token (alternative to auth callback). */
  authToken?: string;
  /** Query parameter name for the token (default: "token"). */
  authParam?: string;
  /**
   * Optional. Periodic token refresh — runs on the leader tab only via
   * `setInterval(refresh, refreshTokenInterval)`. When the timer fires
   * and the connection is currently authenticated, the returned token
   * is passed to `authenticate()` so the server sees the new credentials
   * before the old one expires. Falls back to `auth` if unset.
   *
   * Use this for long-running tabs where the server would otherwise
   * close with an auth-failure code mid-session. Pair with a sensible
   * interval — typically ~80% of your token TTL (e.g. 48 minutes for a
   * 60-minute token).
   *
   * If the callback throws, the failure is logged at `warn` and the
   * timer keeps running for the next interval; the server will still
   * close on its own when the token expires, at which point
   * `authFailureCloseCodes` and `ws.authenticate(...)` handle recovery.
   */
  refresh?: () => string | Promise<string>;
  /**
   * Refresh interval in milliseconds. Disabled when unset or `<= 0`.
   * No default — opt-in.
   */
  refreshTokenInterval?: number;
  /**
   * Max number of follower-routed dispatches each tab buffers locally for
   * replay across leader handover. When the leader dies between receiving
   * a follower's dispatch and writing it to the socket, the new leader
   * gathers pending entries from all tabs and replays them. Cap protects
   * memory; oldest entries are dropped on overflow. Set to `0` to disable
   * the buffer entirely. Default: 100.
   *
   * Note: the replay is at-least-once — a leader that dies AFTER socket
   * write but BEFORE broadcasting "flushed" will cause a duplicate. Make
   * server-side handlers idempotent if duplicates would matter.
   */
  outboundBufferSize?: number;
  /** Run WebSocket inside a Web Worker (offloads JSON parsing, heartbeat from main thread). */
  useWorker?: boolean;
  /** Custom worker URL (if useWorker is true and you want to provide your own worker file). */
  workerUrl?: string | URL;
  /** Override event/field names for server protocol compatibility. */
  events?: Partial<EventProtocol>;
  /** Enable debug logging (default: false). */
  debug?: boolean;
  /** Custom logger (default: console). Supports any logger with debug/info/warn/error. */
  logger?: Logger;
  /**
   * Custom serializer for outgoing messages (default: JSON.stringify).
   * Use for MessagePack, Protobuf, or any binary format.
   */
  serialize?: (data: unknown) => string | ArrayBuffer | Blob;
  /**
   * Custom deserializer for incoming messages (default: JSON.parse).
   * Receives raw WebSocket data (string or ArrayBuffer).
   */
  deserialize?: (raw: string | ArrayBuffer) => unknown;
}

/** Serializer/Deserializer pair. */
export interface Codec {
  serialize: (data: unknown) => string | ArrayBuffer | Blob;
  deserialize: (raw: string | ArrayBuffer) => unknown;
}

/** Configurable event names and field mappings for server protocol. */
export interface EventProtocol {
  /** Field name for event type in messages (default: "event"). */
  eventField: string;
  /** Field name for payload in messages (default: "data"). */
  dataField: string;
  /** Event name sent when joining a channel (default: "$channel:join"). */
  channelJoin: string;
  /** Event name sent when leaving a channel (default: "$channel:leave"). */
  channelLeave: string;
  /** Heartbeat payload sent to keep connection alive (default: { type: "ping" }). */
  ping: unknown;
  /** Fallback event name when message has no event field (default: "message"). */
  defaultEvent: string;
  /** Event name for topic subscribe (default: "$topic:subscribe"). */
  topicSubscribe: string;
  /** Event name for topic unsubscribe (default: "$topic:unsubscribe"). */
  topicUnsubscribe: string;
  /** Event name sent when authenticating at runtime (default: "$auth:login"). */
  authLogin: string;
  /** Event name sent when deauthenticating (default: "$auth:logout"). */
  authLogout: string;
  /** Event name server sends to revoke auth (default: "$auth:revoked"). */
  authRevoked: string;
  /**
   * Optional. Takes full control of outgoing frame shape per `FrameKind`.
   * If unset, the default builder reproduces the legacy two-key envelope:
   *   `{ ...extras, [eventField]: <event-name>, [dataField]: <data> }`
   * using `channelJoin` / `channelLeave` / `topicSubscribe` / etc. for
   * control-frame event names.
   *
   * Return-value contract:
   *   - any concrete value → use as the wire frame
   *   - `null`              → drop the frame (intentional filter / no-op)
   *   - `undefined`         → fall back to the library default for this kind
   *
   * @example Flat envelope (Pusher / Reverb / custom Go server)
   * frameBuilder: (kind, p) => {
   *   switch (kind) {
   *     case 'subscribe':    return { type: 'subscribe',   channel: p.channel };
   *     case 'unsubscribe':  return { type: 'unsubscribe', channel: p.channel };
   *     case 'auth-login':   return { type: 'auth',        token: p.data };
   *     case 'auth-logout':  return { type: 'logout' };
   *     case 'event':
   *       return p.channel
   *         ? { type: 'event', channel: p.channel, event: p.event, data: p.data, ...p.extras }
   *         : { type: 'event', event: p.event, data: p.data, ...p.extras };
   *     default: return undefined; // unknown kind → library default
   *   }
   * }
   */
  frameBuilder?: (kind: FrameKind, payload: FramePayload) => unknown;
  /**
   * Optional. If provided, `channel(name).ready` waits for an incoming
   * frame this matcher classifies as `'ok'` before resolving. Returns:
   *   - `'ok'`       → resolve.
   *   - `'reject'`   → reject with a "subscribe rejected" error.
   *   - `'pending'`  → keep watching subsequent frames.
   *
   * Without a matcher, `Channel.ready` resolves immediately after the
   * subscribe frame is dispatched — appropriate for fire-and-forget
   * servers that don't send subscribe acks.
   *
   * @example Phoenix `phx_reply`
   * channelAckMatcher: (frame, channel) => {
   *   const f = frame as { topic: string; event: string; payload: { status: 'ok' | 'error' } };
   *   if (f.topic !== channel) return 'pending';
   *   if (f.event !== 'phx_reply') return 'pending';
   *   return f.payload.status === 'ok' ? 'ok' : 'reject';
   * }
   */
  channelAckMatcher?: (frame: unknown, channel: string) => ChannelAckResult;
  /** Timeout in ms for `Channel.ready` when `channelAckMatcher` is set. Default: 5000. */
  channelAckTimeout?: number;
}

/** Push notification options. */
export interface PushNotificationOptions {
  /** Only show from leader tab (default: true). Prevents duplicate notifications. */
  leaderOnly?: boolean;
  /** Only show when tab is hidden (default: true). */
  onlyWhenHidden?: boolean;
  /** Default icon for notifications. */
  icon?: string;
  /** Use event field as notification tag for deduplication. */
  tagField?: string;
}

/** Lifecycle event handlers for useSocketLifecycle / onConnect / etc. */
export interface SocketLifecycleHandlers {
  onConnect?: () => void;
  onDisconnect?: () => void;
  onReconnecting?: () => void;
  /** Called when auto-reconnect gives up after exhausting reconnectMaxRetries. */
  onReconnectFailed?: () => void;
  onLeaderChange?: (isLeader: boolean) => void;
  onError?: (error: unknown) => void;
  /** Called when this tab becomes visible/focused. */
  onActive?: () => void;
  /** Called when this tab goes to background/hidden. */
  onInactive?: () => void;
  /** Called on any visibility change. */
  onVisibilityChange?: (isActive: boolean) => void;
  /** Called when auth state changes (authenticate/deauthenticate/server revocation). */
  onAuthChange?: (authenticated: boolean) => void;
}

/**
 * Result returned by `EventProtocol.channelAckMatcher` for each
 * incoming frame while a `Channel` is awaiting its subscribe ack.
 *
 *   - `'ok'`      → resolve `Channel.ready`, stop watching.
 *   - `'reject'`  → reject `Channel.ready` with a "subscribe rejected"
 *                   error, stop watching.
 *   - `'pending'` → keep watching for subsequent frames.
 */
export type ChannelAckResult = 'ok' | 'reject' | 'pending';

/** Scoped channel handle for private/topic-based subscriptions. */
export interface Channel {
  readonly name: string;
  /**
   * Resolves once the server has accepted the subscription. By default
   * (no `channelAckMatcher` configured) this resolves immediately after
   * the subscribe frame is dispatched — fire-and-forget servers don't
   * send acks. Configure `EventProtocol.channelAckMatcher` to wait for
   * a real ack frame; the promise then rejects on a matched
   * "rejected" frame, on `channelAckTimeout`, or if `.leave()` is
   * called before the ack arrives.
   */
  readonly ready: Promise<void>;
  on(event: string, handler: EventHandler): Unsubscribe;
  once(event: string, handler: EventHandler): Unsubscribe;
  send(event: string, data: unknown): void;
  stream(event: string, signal?: AbortSignal): AsyncGenerator<unknown>;
  leave(): void;
}
