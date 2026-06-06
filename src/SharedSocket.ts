import './utils/disposable';
import { backoff } from './utils/backoff';
import type { SocketState, Unsubscribe, EventHandler } from './types';

interface SharedSocketOptions {
  protocols?: string[];
  reconnect?: boolean;
  reconnectMaxDelay?: number;
  /** Max reconnect attempts before giving up (default: Infinity). */
  reconnectMaxRetries?: number;
  /** Close codes that mean "auth failed — stop reconnect." Default: [1008]. */
  authFailureCloseCodes?: number[];
  heartbeatInterval?: number;
  /**
   * Liveness watchdog. When `> 0`, the socket force-reconnects if NO inbound
   * message (server data or a pong) arrives within this many ms. Detects
   * silently-dropped connections that never fire `onclose` (sleep, network
   * switch, captive portal). Requires the server to send periodic data or
   * answer the heartbeat ping. Default: disabled (legacy fire-and-forget).
   */
  heartbeatTimeout?: number;
  sendBuffer?: number;
  auth?: () => string | Promise<string>;
  authToken?: string;
  authParam?: string;
  /** Heartbeat payload (default: { type: "ping" }). */
  pingPayload?: unknown;
  /** Custom serializer (default: JSON.stringify). */
  serialize?: (data: unknown) => string | ArrayBuffer | Blob;
  /** Custom deserializer (default: JSON.parse). */
  deserialize?: (raw: string | ArrayBuffer) => unknown;
}

export class SharedSocket implements Disposable {
  private ws: WebSocket | null = null;
  private _state: SocketState = 'closed';
  private buffer: unknown[] = [];
  private disposed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timestamp of the last inbound message — drives the liveness watchdog. */
  private lastInboundAt = 0;

  private onMessageFns = new Set<EventHandler>();
  private onStateChangeFns = new Set<(state: SocketState) => void>();

  private reconnectAttempts = 0;

  private readonly opts: Required<Omit<SharedSocketOptions, 'auth' | 'authToken' | 'authParam' | 'pingPayload' | 'serialize' | 'deserialize' | 'authFailureCloseCodes' | 'heartbeatTimeout'>> & {
    authFailureCloseCodes: ReadonlySet<number>;
    heartbeatTimeout: number;
    auth?: () => string | Promise<string>;
    authToken?: string;
    authParam: string;
    pingPayload: unknown;
    serialize: (data: unknown) => string | ArrayBuffer | Blob;
    deserialize: (raw: string | ArrayBuffer) => unknown;
  };

  constructor(
    private url: string,
    options: SharedSocketOptions = {},
  ) {
    this.opts = {
      protocols: options.protocols ?? [],
      reconnect: options.reconnect ?? true,
      reconnectMaxDelay: options.reconnectMaxDelay ?? 30_000,
      reconnectMaxRetries: options.reconnectMaxRetries ?? Infinity,
      authFailureCloseCodes: new Set(options.authFailureCloseCodes ?? [1008]),
      heartbeatInterval: options.heartbeatInterval ?? 30_000,
      heartbeatTimeout: options.heartbeatTimeout ?? 0,
      sendBuffer: options.sendBuffer ?? 100,
      auth: options.auth,
      authToken: options.authToken,
      authParam: options.authParam ?? 'token',
      pingPayload: options.pingPayload ?? { type: 'ping' },
      serialize: options.serialize ?? ((data: unknown) => JSON.stringify(data)),
      deserialize: options.deserialize ?? ((raw: string | ArrayBuffer) => {
        if (typeof raw === 'string') return JSON.parse(raw);
        // ArrayBuffer → decode as UTF-8 then parse
        return JSON.parse(new TextDecoder().decode(raw));
      }),
    };
  }

  get state(): SocketState {
    return this._state;
  }

  async connect(): Promise<void> {
    if (this.disposed) return;

    this.setState('connecting');

    let connectUrl: string;
    try {
      connectUrl = await this.buildUrl();
    } catch {
      // auth() threw or returned no token — pause reconnect until user
      // provides fresh creds via ws.authenticate(token) or ws.reconnect().
      this.setState('failed');
      return;
    }
    this.ws = new WebSocket(connectUrl, this.opts.protocols);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.lastInboundAt = Date.now();
      this.setState('connected');
      this.flushBuffer();
      this.startHeartbeat();
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      this.lastInboundAt = Date.now();
      let data: unknown;
      try {
        data = this.opts.deserialize(ev.data as string | ArrayBuffer);
      } catch {
        data = ev.data;
      }
      for (const fn of this.onMessageFns) fn(data);
    };

    this.ws.onclose = (ev) => {
      this.stopHeartbeat();
      if (this.opts.authFailureCloseCodes.has(ev.code)) {
        // Auth-failure close code — don't burn retries with stale creds.
        // User must call ws.authenticate(freshToken) or ws.reconnect() to resume.
        this.setState('failed');
        return;
      }
      if (!this.disposed && this.opts.reconnect) {
        this.scheduleReconnect();
      } else {
        this.setState('closed');
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  disconnect(): void {
    this.disposed = true;
    this.stopHeartbeat();
    this.clearReconnect();

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'client disconnect');
      }
      this.ws = null;
    }

    this.setState('closed');
  }

  send(data: unknown): void {
    if (this._state === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(this.opts.serialize(data));
    } else if (this._state === 'reconnecting' || this._state === 'connecting') {
      if (this.buffer.length < this.opts.sendBuffer) {
        this.buffer.push(data);
      }
    }
  }

  onMessage(fn: EventHandler): Unsubscribe {
    this.onMessageFns.add(fn);
    return () => this.onMessageFns.delete(fn);
  }

  onStateChange(fn: (state: SocketState) => void): Unsubscribe {
    this.onStateChangeFns.add(fn);
    return () => this.onStateChangeFns.delete(fn);
  }

  /**
   * Manually trigger a reconnect. Resets the retry counter and clears any
   * scheduled backoff so the next attempt happens immediately. Use after
   * `state === 'failed'` to let the user retry, or any time to force a
   * fresh connection.
   */
  reconnect(): void {
    if (this.disposed) return;
    this.clearReconnect();
    this.reconnectAttempts = 0;

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'manual reconnect');
      }
      this.ws = null;
    }

    void this.connect();
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.opts.reconnectMaxRetries) {
      this.setState('failed');
      return;
    }

    this.setState('reconnecting');
    const gen = backoff(1000, this.opts.reconnectMaxDelay);

    const attempt = () => {
      if (this.disposed) return;
      const delay = gen.next().value;
      this.reconnectTimer = setTimeout(() => {
        if (!this.disposed) this.connect();
      }, delay);
    };

    attempt();
  }

  private flushBuffer(): void {
    const pending = this.buffer.splice(0);
    for (const item of pending) {
      this.send(item);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // Liveness watchdog: if enabled and we've heard nothing back within the
      // window, the connection is silently dead (no close frame ever came).
      // Force a reconnect rather than sending into the void forever.
      if (
        this.opts.heartbeatTimeout > 0 &&
        this._state === 'connected' &&
        Date.now() - this.lastInboundAt > this.opts.heartbeatTimeout
      ) {
        this.reconnect();
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(this.opts.serialize(this.opts.pingPayload));
      }
    }, this.opts.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async buildUrl(): Promise<string> {
    // Resolve token: callback > static > none
    let token: string | undefined;
    if (this.opts.auth) {
      // If the auth callback throws, let it propagate — connect() catches and
      // pauses reconnect until the user supplies fresh creds.
      token = await this.opts.auth();
      if (!token) {
        // Configured auth callback returned no token. Treat as a fatal auth
        // condition (don't silently connect without credentials).
        throw new Error('SharedSocket: auth() returned no token');
      }
    } else if (this.opts.authToken) {
      token = this.opts.authToken;
    }

    if (!token) return this.url;

    // WebSocket URLs (ws://, wss://) are not fully supported by URL API.
    // Convert to http(s) for parsing, then back to ws(s).
    const httpUrl = this.url.replace(/^ws(s?):\/\//, 'http$1://');
    const parsed = new URL(httpUrl);
    parsed.searchParams.set(this.opts.authParam, token);

    return parsed.toString().replace(/^http(s?):\/\//, 'ws$1://');
  }

  private setState(state: SocketState): void {
    this._state = state;
    for (const fn of this.onStateChangeFns) fn(state);
  }

  [Symbol.dispose](): void {
    this.disconnect();
    this.onMessageFns.clear();
    this.onStateChangeFns.clear();
    this.buffer = [];
  }
}
