export type SocketState = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type TabRole = 'leader' | 'follower';
export type Unsubscribe = () => void;
export type EventHandler = (data: any) => void;

export interface BusMessage {
  id: string;
  source: string;
  topic: string;
  type: 'publish' | 'request' | 'response' | 'broadcast';
  data: unknown;
  timestamp: number;
}

export interface SharedWebSocketOptions {
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
  /**
   * Override event/field names sent over WebSocket.
   * Useful when your server uses different naming conventions.
   *
   * @example
   * // Default
   * events: {
   *   eventField: 'event',       // { event: 'chat.message', data: ... }
   *   dataField: 'data',         // { event: ..., data: { text: 'hi' } }
   *   channelJoin: 'subscribe',  // sent when ws.channel('room') is called
   *   channelLeave: 'unsubscribe',
   *   ping: { type: 'ping' },    // heartbeat payload
   * }
   */
  events?: Partial<EventProtocol>;
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
