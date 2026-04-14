import { SharedWebSocket } from './SharedWebSocket';
import type { SharedWebSocketOptions } from './types';

/**
 * Scoped WebSocket lifecycle — creates, connects, and auto-disposes.
 * Guarantees cleanup even on errors. No polyfills needed.
 *
 * @example
 * // Async (awaits callback completion, then disposes)
 * await withSocket('wss://api.example.com/ws', async (ws) => {
 *   ws.on('order.created', (order) => console.log(order));
 *   await longRunningWork();
 * });
 *
 * @example
 * // With options
 * await withSocket('wss://api.example.com/ws', {
 *   auth: () => localStorage.getItem('token')!,
 * }, async (ws) => {
 *   const user = await ws.request('user.profile', { id: 1 });
 *   console.log(user);
 * });
 *
 * @example
 * // With AbortController for external cancellation
 * const controller = new AbortController();
 * setTimeout(() => controller.abort(), 30_000); // 30s timeout
 *
 * await withSocket('wss://api.example.com/ws', async (ws, signal) => {
 *   for await (const msg of ws.stream('chat.messages', signal)) {
 *     renderMessage(msg);
 *   }
 * }, { signal: controller.signal });
 */
export async function withSocket(
  url: string,
  optionsOrCallback: SharedWebSocketOptions | WithSocketCallback,
  callbackOrScopeOptions?: WithSocketCallback | WithSocketScopeOptions,
  maybeScopeOptions?: WithSocketScopeOptions,
): Promise<void> {
  // Overload resolution
  let options: SharedWebSocketOptions | undefined;
  let callback: WithSocketCallback;
  let scopeOptions: WithSocketScopeOptions | undefined;

  if (typeof optionsOrCallback === 'function') {
    callback = optionsOrCallback;
    scopeOptions = callbackOrScopeOptions as WithSocketScopeOptions | undefined;
  } else {
    options = optionsOrCallback;
    callback = callbackOrScopeOptions as WithSocketCallback;
    scopeOptions = maybeScopeOptions;
  }

  const ws = new SharedWebSocket(url, options);
  const controller = new AbortController();

  // Link external signal if provided
  if (scopeOptions?.signal) {
    if (scopeOptions.signal.aborted) {
      ws[Symbol.dispose]();
      throw scopeOptions.signal.reason ?? new Error('Aborted');
    }
    scopeOptions.signal.addEventListener('abort', () => controller.abort(scopeOptions!.signal!.reason), { once: true });
  }

  try {
    await ws.connect();
    await callback(ws, controller.signal);
  } finally {
    controller.abort();
    ws[Symbol.dispose]();
  }
}

export type WithSocketCallback = (ws: SharedWebSocket, signal: AbortSignal) => void | Promise<void>;

export interface WithSocketScopeOptions {
  /** External AbortSignal — aborts the callback and disposes the socket. */
  signal?: AbortSignal;
}
