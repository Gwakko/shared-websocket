import { useEffect, useState } from 'react';
import { useSharedWebSocket } from './context';
import type { Channel } from '../../types';

/**
 * Subscribe to a private channel. Joins once the socket is ready, leaves on
 * unmount. Returns `null` until the channel is joined.
 *
 * @example
 * const chat = useChannel('chat:room_123');
 * const message = useSocketEvent('chat:room_123:message');
 * chat?.send('message', { text: 'Hello' });
 */
export function useChannel(name: string, options?: { auth?: boolean }): Channel | null {
  const socket = useSharedWebSocket();
  const [channel, setChannel] = useState<Channel | null>(null);

  useEffect(() => {
    if (!socket) return;
    const ch = socket.channel(name, options);
    setChannel(ch);
    return () => {
      ch.leave();
      setChannel(null);
    };
  }, [socket, name]);

  return channel;
}

/**
 * Subscribe to server-side topics. Subscribes once the socket is ready,
 * unsubscribes on unmount.
 *
 * @example
 * useTopics(['notifications:orders', 'notifications:payments']);
 */
export function useTopics(topics: string[], options?: { auth?: boolean }): void {
  const socket = useSharedWebSocket();

  useEffect(() => {
    if (!socket) return;
    topics.forEach((t) => socket.subscribe(t, options));
    return () => topics.forEach((t) => socket.unsubscribe(t));
  }, [socket, topics.join(',')]);
}

/**
 * Enable browser push notifications for an event. Activates once the socket is
 * ready, cleans up on unmount.
 *
 * @example
 * usePush('order.created', {
 *   title: (order) => `New Order #${order.id}`,
 *   body: (order) => `$${order.total}`,
 * });
 */
export function usePush<T = unknown>(
  event: string,
  config: {
    title: string | ((data: T) => string);
    body?: string | ((data: T) => string);
    icon?: string;
    tag?: string | ((data: T) => string);
    leaderOnly?: boolean;
    onlyWhenHidden?: boolean;
    onClick?: (data: T) => void;
  },
): void {
  const socket = useSharedWebSocket();

  useEffect(() => {
    if (!socket) return;
    return socket.push<T>(event, config);
  }, [socket, event]);
}
