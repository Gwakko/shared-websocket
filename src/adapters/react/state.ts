import { useEffect, useState, useEffectEvent } from 'react';
import { useSharedWebSocket } from './context';

/**
 * Two-way state sync across browser tabs.
 * - Without callback: returns [value, setter] (like useState but synced).
 * - With callback: calls your handler when any tab updates this key.
 *
 * While the socket is null the setter updates local state only; it broadcasts
 * once the socket is ready.
 *
 * @example
 * const [cart, setCart] = useSocketSync<Cart>('cart', { items: [] });
 */
export function useSocketSync<T>(
  key: string,
  initialValue: T,
  callback?: (value: T) => void,
): [T, (value: T) => void] {
  const socket = useSharedWebSocket();
  const [value, setValue] = useState<T>(() => socket?.getSync<T>(key) ?? initialValue);

  const onSync = useEffectEvent((synced: T) => {
    setValue(synced);
    callback?.(synced);
  });

  useEffect(() => {
    if (!socket) return;
    return socket.onSync<T>(key, onSync);
  }, [socket, key]);

  const setAndSync = useEffectEvent((newValue: T) => {
    setValue(newValue);
    socket?.sync(key, newValue);
  });

  return [value, setAndSync];
}
