import { ref, onUnmounted, readonly, type Ref } from 'vue';
import { useSharedWebSocket } from './plugin';

/**
 * Subscribe to a WebSocket event.
 * - Without callback: returns reactive ref with latest value.
 * - With callback: calls your handler on each event.
 *
 * @example
 * // Reactive state
 * const order = useSocketEvent<Order>('order.created');
 *
 * @example
 * // Custom callback
 * useSocketEvent<Order>('order.created', (order) => {
 *   playSound('new-order');
 *   analytics.track('order_received', order);
 * });
 */
export function useSocketEvent<T>(event: string, callback?: (data: T, raw?: unknown) => void): Ref<T | undefined> {
  const socket = useSharedWebSocket();
  const value = ref<T | undefined>(undefined) as Ref<T | undefined>;

  const handler = (data: unknown, raw?: unknown) => {
    const typed = data as T;
    if (callback) {
      callback(typed, raw);
    } else {
      value.value = typed;
    }
  };
  const unsub = socket.on(event, handler);

  onUnmounted(unsub);
  return readonly(value) as Ref<T | undefined>;
}

/**
 * Accumulate WebSocket events.
 * - Without callback: returns reactive array.
 * - With callback: calls your handler — manage your own state.
 *
 * @example
 * // Default accumulation
 * const messages = useSocketStream<ChatMessage>('chat.message');
 *
 * @example
 * // Custom — keep last 50
 * const messages = ref<ChatMessage[]>([]);
 * useSocketStream<ChatMessage>('chat.message', (msg) => {
 *   messages.value = [msg, ...messages.value].slice(0, 50);
 * });
 *
 * @example
 * // Custom — filter by type
 * const errors = ref<LogEntry[]>([]);
 * useSocketStream<LogEntry>('log.entry', (entry) => {
 *   if (entry.level === 'error') errors.value = [...errors.value, entry];
 * });
 */
export function useSocketStream<T>(event: string, callback?: (data: T, raw?: unknown) => void): Ref<T[]> {
  const socket = useSharedWebSocket();
  const items = ref<T[]>([]) as Ref<T[]>;

  const handler = (data: unknown, raw?: unknown) => {
    const typed = data as T;
    if (callback) {
      callback(typed, raw);
    } else {
      items.value = [...items.value, typed];
    }
  };
  const unsub = socket.on(event, handler);

  onUnmounted(unsub);
  return readonly(items) as Ref<T[]>;
}

/**
 * Fire-and-forget event handler — no state, no ref.
 *
 * @example
 * useSocketCallback<Notification>('notification', (n) => {
 *   showToast(n.title);
 * });
 */
export function useSocketCallback<T>(event: string, callback: (data: T, raw?: unknown) => void): void {
  const socket = useSharedWebSocket();

  const unsub = socket.on(event, (data: unknown, raw?: unknown) => {
    callback(data as T, raw);
  });

  onUnmounted(unsub);
}
