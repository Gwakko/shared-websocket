import './utils/disposable';
import type { SocketState, Unsubscribe, EventHandler } from './types';

/**
 * WorkerSocket — WebSocket running inside a Web Worker.
 *
 * Same interface as SharedSocket, but WebSocket lives off main thread.
 * Benefits: heartbeat timers and JSON parsing don't block UI rendering.
 *
 * Use when:
 * - High message rate (50+ msgs/sec)
 * - Heavy JSON payloads
 * - UI does complex rendering that could block main thread
 *
 * Don't use when:
 * - Low message rate (simple chat, notifications)
 * - Bundle size matters (adds worker file)
 * - Debugging (Worker DevTools is less convenient)
 */
export class WorkerSocket implements Disposable {
  private worker: Worker | null = null;
  private _state: SocketState = 'closed';

  private onMessageFns = new Set<EventHandler>();
  private onStateChangeFns = new Set<(state: SocketState) => void>();

  constructor(
    private url: string,
    private options: {
      protocols?: string[];
      reconnect?: boolean;
      reconnectMaxDelay?: number;
      reconnectMaxRetries?: number;
      heartbeatInterval?: number;
      sendBuffer?: number;
      workerUrl?: string | URL;
      auth?: () => string | Promise<string>;
      authToken?: string;
      authParam?: string;
      pingPayload?: unknown;
    } = {},
  ) {}

  get state(): SocketState {
    return this._state;
  }

  async connect(): Promise<void> {
    // Resolve auth token before sending to worker (functions can't cross worker boundary)
    let authToken: string | undefined;
    if (this.options.auth) {
      authToken = await this.options.auth();
    } else if (this.options.authToken) {
      authToken = this.options.authToken;
    }

    // Build URL with auth token
    const connectUrl = authToken ? this.buildUrl(authToken) : this.url;

    // Create worker from inline blob if no workerUrl provided
    const workerUrl = this.options.workerUrl ?? this.createWorkerBlob();

    this.worker = new Worker(workerUrl, { type: 'module' });

    this.worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;

      switch (msg.type) {
        case 'state':
          this._state = msg.state;
          for (const fn of this.onStateChangeFns) fn(msg.state);
          break;

        case 'message':
          for (const fn of this.onMessageFns) fn(msg.data);
          break;

        case 'open':
          // State already set via 'state' message
          break;

        case 'close':
          break;

        case 'error':
          console.error('WorkerSocket error:', msg.message);
          break;
      }
    };

    this.worker.postMessage({
      type: 'connect',
      url: connectUrl,
      protocols: this.options.protocols ?? [],
      reconnect: this.options.reconnect ?? true,
      reconnectMaxDelay: this.options.reconnectMaxDelay ?? 30_000,
      reconnectMaxRetries: this.options.reconnectMaxRetries ?? Infinity,
      heartbeatInterval: this.options.heartbeatInterval ?? 30_000,
      bufferSize: this.options.sendBuffer ?? 100,
      pingPayload: this.options.pingPayload,
    });
  }

  private buildUrl(token: string): string {
    const param = this.options.authParam ?? 'token';
    const httpUrl = this.url.replace(/^ws(s?):\/\//, 'http$1://');
    const parsed = new URL(httpUrl);
    parsed.searchParams.set(param, token);
    return parsed.toString().replace(/^http(s?):\/\//, 'ws$1://');
  }

  send(data: unknown): void {
    this.worker?.postMessage({ type: 'send', data });
  }

  disconnect(): void {
    this.worker?.postMessage({ type: 'disconnect' });
    setTimeout(() => {
      this.worker?.terminate();
      this.worker = null;
    }, 100);
    this._state = 'closed';
  }

  onMessage(fn: EventHandler): Unsubscribe {
    this.onMessageFns.add(fn);
    return () => this.onMessageFns.delete(fn);
  }

  onStateChange(fn: (state: SocketState) => void): Unsubscribe {
    this.onStateChangeFns.add(fn);
    return () => this.onStateChangeFns.delete(fn);
  }

  private createWorkerBlob(): URL {
    // Inline the worker code as a blob URL
    // In production, use a bundler (Vite, webpack) to handle worker imports
    const code = `
      let ws = null, state = 'closed', buffer = [], disposed = false;
      let heartbeatTimer = null, reconnectTimer = null;
      let url = '', protocols = [], shouldReconnect = true;
      let maxDelay = 30000, maxRetries = Infinity, hbInterval = 30000, maxBuf = 100;
      let delay = 1000, attempts = 0, pingPayload = '{"type":"ping"}';

      function setState(s) { state = s; self.postMessage({ type: 'state', state: s }); }
      function connect() {
        if (disposed) return;
        setState('connecting');
        ws = new WebSocket(url, protocols);
        ws.onopen = () => { attempts = 0; delay = 1000; setState('connected'); self.postMessage({ type: 'open' }); flush(); startHB(); };
        ws.onmessage = (e) => { let d; try { d = JSON.parse(e.data); } catch { d = e.data; } self.postMessage({ type: 'message', data: d }); };
        ws.onclose = (e) => { stopHB(); self.postMessage({ type: 'close', code: e.code, reason: e.reason }); if (!disposed && shouldReconnect && e.code !== 1000) reconnect(); else setState('closed'); };
        ws.onerror = () => { self.postMessage({ type: 'error', message: 'error' }); };
      }
      function send(d) { if (state === 'connected' && ws?.readyState === 1) ws.send(JSON.stringify(d)); else if (buffer.length < maxBuf) buffer.push(d); }
      function flush() { const p = buffer.splice(0); p.forEach(send); }
      function startHB() { stopHB(); heartbeatTimer = setInterval(() => { if (ws?.readyState === 1) ws.send(pingPayload); }, hbInterval); }
      function stopHB() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }
      function reconnect() {
        attempts++;
        if (attempts > maxRetries) { setState('closed'); return; }
        setState('reconnecting');
        const j = delay * 0.25 * (Math.random() * 2 - 1);
        reconnectTimer = setTimeout(() => { if (!disposed) connect(); }, Math.min(delay + j, maxDelay));
        delay = Math.min(delay * 2, maxDelay);
      }
      self.onmessage = (e) => {
        const c = e.data;
        if (c.type === 'connect') { url = c.url; protocols = c.protocols || []; shouldReconnect = c.reconnect ?? true; maxDelay = c.reconnectMaxDelay || 30000; maxRetries = c.reconnectMaxRetries ?? Infinity; hbInterval = c.heartbeatInterval || 30000; maxBuf = c.bufferSize || 100; if (c.pingPayload) pingPayload = JSON.stringify(c.pingPayload); connect(); }
        if (c.type === 'send') send(c.data);
        if (c.type === 'disconnect') { disposed = true; stopHB(); if (reconnectTimer) clearTimeout(reconnectTimer); if (ws) { ws.onclose = null; if (ws.readyState < 2) ws.close(1000); ws = null; } buffer = []; setState('closed'); }
      };
    `;
    const blob = new Blob([code], { type: 'application/javascript' });
    return new URL(URL.createObjectURL(blob));
  }

  [Symbol.dispose](): void {
    this.disconnect();
    this.onMessageFns.clear();
    this.onStateChangeFns.clear();
  }
}
