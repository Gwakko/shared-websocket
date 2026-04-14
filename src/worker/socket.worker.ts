/**
 * WebSocket Worker — runs WebSocket connection off the main thread.
 *
 * Communication with main thread via postMessage:
 *
 * Main → Worker:
 *   { type: 'connect', url: string, protocols?: string[] }
 *   { type: 'send', data: unknown }
 *   { type: 'disconnect' }
 *
 * Worker → Main:
 *   { type: 'open' }
 *   { type: 'message', data: unknown }
 *   { type: 'close', code: number, reason: string }
 *   { type: 'error', message: string }
 *   { type: 'state', state: SocketState }
 */

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
}

let ws: WebSocket | null = null;
let state: SocketState = 'closed';
let buffer: unknown[] = [];
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;

let currentUrl = '';
let currentProtocols: string[] = [];
let shouldReconnect = true;
let maxDelay = 30_000;
let heartbeatInterval = 30_000;
let maxBuffer = 100;

// Backoff state
let backoffDelay = 1000;

function setState(s: SocketState) {
  state = s;
  self.postMessage({ type: 'state', state: s });
}

function connect(url: string, protocols: string[]) {
  if (disposed) return;

  currentUrl = url;
  currentProtocols = protocols;
  backoffDelay = 1000;

  doConnect();
}

function doConnect() {
  if (disposed) return;
  setState('connecting');

  try {
    ws = new WebSocket(currentUrl, currentProtocols);
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
      data = JSON.parse(ev.data as string);
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
    ws.send(JSON.stringify(data));
  } else if (state === 'connecting' || state === 'reconnecting') {
    if (buffer.length < maxBuffer) {
      buffer.push(data);
    }
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
  for (const item of pending) {
    send(item);
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, heartbeatInterval);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect() {
  setState('reconnecting');
  clearReconnect();

  const jitter = backoffDelay * 0.25 * (Math.random() * 2 - 1);
  const delay = Math.min(backoffDelay + jitter, maxDelay);

  reconnectTimer = setTimeout(() => {
    if (!disposed) doConnect();
  }, delay);

  backoffDelay = Math.min(backoffDelay * 2, maxDelay);
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// Listen for commands from main thread
self.onmessage = (ev: MessageEvent<WorkerCommand>) => {
  const cmd = ev.data;

  switch (cmd.type) {
    case 'connect':
      if (cmd.reconnect !== undefined) shouldReconnect = cmd.reconnect;
      if (cmd.reconnectMaxDelay) maxDelay = cmd.reconnectMaxDelay;
      if (cmd.heartbeatInterval) heartbeatInterval = cmd.heartbeatInterval;
      if (cmd.bufferSize) maxBuffer = cmd.bufferSize;
      connect(cmd.url!, cmd.protocols ?? []);
      break;

    case 'send':
      send(cmd.data);
      break;

    case 'disconnect':
      disconnect();
      break;
  }
};
