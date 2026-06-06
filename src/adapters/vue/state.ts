import { ref, onUnmounted, watch, type Ref } from 'vue';
import { useSharedWebSocket } from './plugin';

/**
 * Two-way state sync across browser tabs.
 * - Without callback: reactive ref synced across tabs.
 * - With callback: called when any tab updates this key — side effects.
 *
 * @example
 * // Reactive two-way sync
 * const cart = useSocketSync<Cart>('cart', { items: [] });
 * cart.value = { items: [1, 2, 3] }; // syncs to all tabs
 *
 * @example
 * // With side effect callback
 * const cart = useSocketSync<Cart>('cart', { items: [] }, (cart) => {
 *   document.title = `Cart (${cart.items.length})`;
 *   analytics.track('cart_updated');
 * });
 */
export function useSocketSync<T>(key: string, initialValue: T, callback?: (value: T) => void): Ref<T> {
  const socket = useSharedWebSocket();
  const value = ref<T>(socket.getSync<T>(key) ?? initialValue) as Ref<T>;

  const unsub = socket.onSync<T>(key, (v) => {
    value.value = v;
    callback?.(v);
  });

  watch(
    value,
    (newVal) => {
      socket.sync(key, newVal);
    },
    { deep: true },
  );

  onUnmounted(unsub);
  return value;
}
