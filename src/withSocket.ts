import { SharedWebSocket } from './SharedWebSocket';
import type { SharedWebSocketOptions } from './types';

/**
 * Callback context — destructure what you need.
 */
export interface SocketScope {
  /** The SharedWebSocket instance. */
  ws: SharedWebSocket;
  /** AbortSignal — aborted when scope exits (use with stream/fetch). */
  signal: AbortSignal;
}

export interface WithSocketOptions extends SharedWebSocketOptions {
  /** External AbortSignal — aborts the scope and disposes the socket. */
  signal?: AbortSignal;
}

/**
 * Scoped WebSocket lifecycle — creates, connects, and auto-disposes.
 * Guarantees cleanup even on errors. No polyfills needed.
 *
 * @example
 * // Basic — destructure { ws }
 * await withSocket('wss://api.example.com/ws', async ({ ws }) => {
 *   ws.on('order.created', (order) => console.log(order));
 *   await longRunningWork();
 * });
 *
 * @example
 * // With auth and signal
 * await withSocket('wss://api.example.com/ws', {
 *   auth: () => localStorage.getItem('token')!,
 * }, async ({ ws, signal }) => {
 *   for await (const msg of ws.stream('chat.messages', signal)) {
 *     renderMessage(msg);
 *   }
 * });
 *
 * @example
 * // External cancellation
 * const controller = new AbortController();
 * setTimeout(() => controller.abort(), 30_000);
 *
 * await withSocket('wss://api.example.com/ws', {
 *   signal: controller.signal,
 * }, async ({ ws, signal }) => {
 *   ws.on('notifications', (n) => showToast(n));
 *   // Stays alive until controller aborts or scope exits
 *   await new Promise((_, reject) => signal.addEventListener('abort', reject));
 * });
 */
export async function withSocket(
  url: string,
  optionsOrCallback: WithSocketOptions | WithSocketCallback,
  maybeCallback?: WithSocketCallback,
): Promise<void> {
  let options: WithSocketOptions | undefined;
  let callback: WithSocketCallback;

  if (typeof optionsOrCallback === 'function') {
    callback = optionsOrCallback;
  } else {
    options = optionsOrCallback;
    callback = maybeCallback!;
  }

  const ws = new SharedWebSocket(url, options);
  const controller = new AbortController();

  // Link external signal
  if (options?.signal) {
    if (options.signal.aborted) {
      ws[Symbol.dispose]();
      throw options.signal.reason ?? new Error('Aborted');
    }
    options.signal.addEventListener('abort', () => controller.abort(options!.signal!.reason), { once: true });
  }

  try {
    await ws.connect();
    await callback({ ws, signal: controller.signal });
  } finally {
    controller.abort();
    ws[Symbol.dispose]();
  }
}

export type WithSocketCallback = (scope: SocketScope) => void | Promise<void>;
