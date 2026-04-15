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
