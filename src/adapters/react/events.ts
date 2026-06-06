import { useEffect, useState, useEffectEvent } from 'react';
import { useSharedWebSocket } from './context';
import type { EventHandler } from '../../types';

/**
 * Subscribe to a WebSocket event.
 * - Without callback: returns the latest received value (reactive state).
 * - With callback: calls your handler on each event (stable ref via useEffectEvent).
 *
 * Subscription attaches automatically once the socket is ready (no-op while null).
 *
 * @example
 * const order = useSocketEvent<Order>('order.created');
 *
 * @example
 * useSocketEvent<Order>('order.created', (order) => playSound('new-order'));
 */
export function useSocketEvent<T>(event: string, callback?: (data: T, raw?: unknown) => void): T | undefined {
  const socket = useSharedWebSocket();
  const [value, setValue] = useState<T | undefined>(undefined);

  const onEvent = useEffectEvent((data: T, raw?: unknown) => {
    if (callback) {
      callback(data, raw);
    } else {
      setValue(data);
    }
  });

  useEffect(() => {
    if (!socket) return;
    return socket.on(event, onEvent as EventHandler);
  }, [socket, event]);

  return callback ? undefined : value;
}

/**
 * Accumulate WebSocket events into an array.
 * - Without callback: returns accumulated array (reactive state).
 * - With callback: calls your handler on each event, you manage your own state.
 *
 * @example
 * const messages = useSocketStream<ChatMessage>('chat.message');
 *
 * @example
 * useSocketStream<ChatMessage>('chat.message', (msg) =>
 *   setMessages((prev) => [msg, ...prev].slice(0, 50)),
 * );
 */
export function useSocketStream<T>(event: string, callback?: (data: T, raw?: unknown) => void): T[] {
  const socket = useSharedWebSocket();
  const [items, setItems] = useState<T[]>([]);

  const onEvent = useEffectEvent((data: T, raw?: unknown) => {
    if (callback) {
      callback(data, raw);
    } else {
      setItems((prev) => [...prev, data]);
    }
  });

  useEffect(() => {
    if (!socket) return;
    if (!callback) setItems([]);
    return socket.on(event, onEvent as EventHandler);
  }, [socket, event]);

  return callback ? [] : items;
}

/**
 * Subscribe to a WebSocket event with just a callback — no state, no return value.
 * Fire-and-forget: side effects, logging, analytics, sounds, browser notifications.
 *
 * @example
 * useSocketCallback<Order>('order.created', (order) => playSound('new-order'));
 */
export function useSocketCallback<T>(event: string, callback: (data: T, raw?: unknown) => void): void {
  const socket = useSharedWebSocket();

  const handler = useEffectEvent((data: T, raw?: unknown) => {
    callback(data, raw);
  });

  useEffect(() => {
    if (!socket) return;
    return socket.on(event, handler as EventHandler);
  }, [socket, event]);
}
