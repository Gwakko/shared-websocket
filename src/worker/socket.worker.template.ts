/**
 * Custom WebSocket Worker Template
 *
 * Copy this file into your project and customize serialize/deserialize.
 * Then pass the URL to SharedWebSocket:
 *
 * @example
 * // Vite
 * new SharedWebSocket(url, {
 *   useWorker: true,
 *   workerUrl: new URL('./my-socket.worker.ts', import.meta.url),
 * });
 *
 * @example
 * // Webpack
 * new SharedWebSocket(url, {
 *   useWorker: true,
 *   workerUrl: new URL('./my-socket.worker.ts', import.meta.url),
 * });
 *
 * @example
 * // Static file
 * new SharedWebSocket(url, {
 *   useWorker: true,
 *   workerUrl: '/workers/my-socket.worker.js',
 * });
 */

// ─── CUSTOMIZE HERE ──────────────────────────────

// Replace with your serialization library:
// import { encode, decode } from '@msgpack/msgpack';
// import { MyMessage } from './proto/messages';

function serialize(data: unknown): string | ArrayBuffer {
  // Default: JSON
  return JSON.stringify(data);

  // MessagePack:
  // return encode(data);

  // Protobuf:
  // return MyMessage.encode(data as MyMessage).finish();
}

function deserialize(raw: string | ArrayBuffer): unknown {
  // Default: JSON
  if (typeof raw === 'string') return JSON.parse(raw);
  return JSON.parse(new TextDecoder().decode(raw as ArrayBuffer));

  // MessagePack:
  // return decode(raw as ArrayBuffer);

  // Protobuf:
  // return MyMessage.decode(new Uint8Array(raw as ArrayBuffer));
}

// ─── WORKER LOGIC (do not modify below) ──────────

type SocketState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

interface WorkerCommand {
  type: 'connect' | 'send' | 'disconnect';
  url?: string;
  protocols?: string[];
  data?: unknown;
  reconnect?: boolean;
  reconnectMaxDelay?: number;
  heartbeatInterval?: number;
  bufferSize?: number;
  pingPayload?: unknown;
}

let ws: WebSocket | null = null;
let state: SocketState = 'closed';
let buffer: unknown[] = [];
let disposed = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

let currentUrl = '';
let currentProtocols: string[] = [];
let shouldReconnect = true;
let maxDelay = 30_000;
let heartbeatInterval = 30_000;
let maxBuffer = 100;
let pingPayload: unknown = { type: 'ping' };
let backoffDelay = 1000;

function setState(s: SocketState) {
  state = s;
  self.postMessage({ type: 'state', state: s });
}

function connect() {
  if (disposed) return;
  setState('connecting');

  try {
    ws = new WebSocket(currentUrl, currentProtocols);
    if (typeof serialize({}) !== 'string') {
      ws.binaryType = 'arraybuffer';
    }
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e) });
    if (shouldReconnect) scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    setState('connected');
    backoffDelay = 1000;
    self.postMessage({ type: 'open' });
    flushBuffer();
    startHeartbeat();
  };

  ws.onmessage = (ev: MessageEvent) => {
    let data: unknown;
    try {
      data = deserialize(ev.data);
    } catch {
      data = ev.data;
    }
    self.postMessage({ type: 'message', data });
  };

  ws.onclose = (ev) => {
    stopHeartbeat();
    self.postMessage({ type: 'close', code: ev.code, reason: ev.reason });
    if (!disposed && shouldReconnect && ev.code !== 1000) {
      scheduleReconnect();
    } else {
      setState('closed');
    }
  };

  ws.onerror = () => {
    self.postMessage({ type: 'error', message: 'WebSocket error' });
  };
}

function send(data: unknown) {
  if (state === 'connected' && ws?.readyState === WebSocket.OPEN) {
    ws.send(serialize(data));
  } else if (buffer.length < maxBuffer) {
    buffer.push(data);
  }
}

function disconnect() {
  disposed = true;
  shouldReconnect = false;
  stopHeartbeat();
  clearReconnect();
  if (ws) {
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, 'worker disconnect');
    }
    ws = null;
  }
  buffer = [];
  setState('closed');
}

function flushBuffer() {
  const pending = buffer.splice(0);
  for (const item of pending) send(item);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(serialize(pingPayload));
    }
  }, heartbeatInterval);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function scheduleReconnect() {
  setState('reconnecting');
  clearReconnect();
  const jitter = backoffDelay * 0.25 * (Math.random() * 2 - 1);
  const delay = Math.min(backoffDelay + jitter, maxDelay);
  reconnectTimer = setTimeout(() => { if (!disposed) connect(); }, delay);
  backoffDelay = Math.min(backoffDelay * 2, maxDelay);
}

function clearReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

self.onmessage = (ev: MessageEvent<WorkerCommand>) => {
  const cmd = ev.data;
  switch (cmd.type) {
    case 'connect':
      currentUrl = cmd.url!;
      currentProtocols = cmd.protocols ?? [];
      if (cmd.reconnect !== undefined) shouldReconnect = cmd.reconnect;
      if (cmd.reconnectMaxDelay) maxDelay = cmd.reconnectMaxDelay;
      if (cmd.heartbeatInterval) heartbeatInterval = cmd.heartbeatInterval;
      if (cmd.bufferSize) maxBuffer = cmd.bufferSize;
      if (cmd.pingPayload !== undefined) pingPayload = cmd.pingPayload;
      connect();
      break;
    case 'send':
      send(cmd.data);
      break;
    case 'disconnect':
      disconnect();
      break;
  }
};
