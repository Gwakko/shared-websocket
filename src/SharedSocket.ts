import './utils/disposable';
import { backoff } from './utils/backoff';
import type { SocketState, Unsubscribe, EventHandler } from './types';

interface SharedSocketOptions {
  protocols?: string[];
  reconnect?: boolean;
  reconnectMaxDelay?: number;
  heartbeatInterval?: number;
  sendBuffer?: number;
  auth?: () => string | Promise<string>;
}

export class SharedSocket implements Disposable {
  private ws: WebSocket | null = null;
  private _state: SocketState = 'closed';
  private buffer: unknown[] = [];
  private disposed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private onMessageFns = new Set<EventHandler>();
  private onStateChangeFns = new Set<(state: SocketState) => void>();

  private readonly opts: Required<Omit<SharedSocketOptions, 'auth'>> & { auth?: () => string | Promise<string> };

  constructor(
    private url: string,
    options: SharedSocketOptions = {},
  ) {
    this.opts = {
      protocols: options.protocols ?? [],
      reconnect: options.reconnect ?? true,
      reconnectMaxDelay: options.reconnectMaxDelay ?? 30_000,
      heartbeatInterval: options.heartbeatInterval ?? 30_000,
      sendBuffer: options.sendBuffer ?? 100,
      auth: options.auth,
    };
  }

  get state(): SocketState {
    return this._state;
  }

  async connect(): Promise<void> {
    if (this.disposed) return;

    this.setState('connecting');

    let connectUrl = this.url;
    if (this.opts.auth) {
      const token = await this.opts.auth();
      const sep = connectUrl.includes('?') ? '&' : '?';
      connectUrl = `${connectUrl}${sep}token=${encodeURIComponent(token)}`;
    }

    this.ws = new WebSocket(connectUrl, this.opts.protocols);

    this.ws.onopen = () => {
      this.setState('connected');
      this.flushBuffer();
      this.startHeartbeat();
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(ev.data as string);
      } catch {
        data = ev.data;
      }
      for (const fn of this.onMessageFns) fn(data);
    };

    this.ws.onclose = () => {
      this.stopHeartbeat();
      if (!this.disposed && this.opts.reconnect) {
        this.reconnect();
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
      this.ws.send(JSON.stringify(data));
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

  private reconnect(): void {
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
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
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
