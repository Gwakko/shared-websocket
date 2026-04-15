export type SocketState = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type TabRole = 'leader' | 'follower';
export type Unsubscribe = () => void;
export type EventHandler<T = any> = (data: T) => void;

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

export interface SharedWebSocketOptions<TEvents extends EventMap = EventMap> {
  protocols?: string[];
  reconnect?: boolean;
  reconnectMaxDelay?: number;
  heartbeatInterval?: number;
  electionTimeout?: number;
  leaderHeartbeat?: number;
  leaderTimeout?: number;
  sendBuffer?: number;
  /** Auth token provider — called before each connect/reconnect. */
  auth?: () => string | Promise<string>;
  /** Static auth token (alternative to auth callback). */
  authToken?: string;
  /** Query parameter name for the token (default: "token"). */
  authParam?: string;
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
}

/** Lifecycle event handlers for useSocketLifecycle / onConnect / etc. */
export interface SocketLifecycleHandlers {
  onConnect?: () => void;
  onDisconnect?: () => void;
  onReconnecting?: () => void;
  onLeaderChange?: (isLeader: boolean) => void;
  onError?: (error: unknown) => void;
}

/** Scoped channel handle for private/topic-based subscriptions. */
export interface Channel {
  readonly name: string;
  on(event: string, handler: EventHandler): Unsubscribe;
  once(event: string, handler: EventHandler): Unsubscribe;
  send(event: string, data: unknown): void;
  stream(event: string, signal?: AbortSignal): AsyncGenerator<unknown>;
  leave(): void;
}
