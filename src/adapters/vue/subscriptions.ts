import { onUnmounted } from 'vue';
import { useSharedWebSocket } from './plugin';

/**
 * Subscribe to a private channel. Auto-joins on mount, leaves on unmount.
 *
 * @example
 * const chat = useChannel('chat:room_123');
 * // Listen via useSocketEvent('chat:room_123:message')
 * // Send via chat.send('message', { text: 'Hello' })
 */
export function useChannel(name: string, options?: { auth?: boolean }) {
  const socket = useSharedWebSocket();
  const channel = socket.channel(name, options);

  onUnmounted(() => channel.leave());

  return channel;
}

/**
 * Subscribe to server-side topics. Auto-unsubscribes on unmount.
 *
 * @example
 * useTopics(['notifications:orders', 'notifications:payments']);
 */
export function useTopics(topics: string[], options?: { auth?: boolean }): void {
  const socket = useSharedWebSocket();

  topics.forEach((t) => socket.subscribe(t, options));

  onUnmounted(() => {
    topics.forEach((t) => socket.unsubscribe(t));
  });
}

/**
 * Enable browser push notifications for an event. Auto-cleanup on unmount.
 *
 * @example
 * usePush('notification', {
 *   title: (n) => n.title,
 *   body: (n) => n.body,
 *   icon: '/icon.png',
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
  const unsub = socket.push<T>(event, config);

  onUnmounted(unsub);
}
