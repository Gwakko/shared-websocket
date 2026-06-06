import { inject, type InjectionKey, type App } from 'vue';
import { SharedWebSocket } from '../../SharedWebSocket';
import type { SharedWebSocketOptions } from '../../types';

// ─── Plugin ──────────────────────────────────────────────

export const SharedWebSocketKey: InjectionKey<SharedWebSocket> = Symbol('SharedWebSocket');

/**
 * Vue 3 plugin for SharedWebSocket.
 *
 * @example
 * const app = createApp(App);
 * app.use(createSharedWebSocketPlugin('wss://api.example.com/ws', {
 *   auth: () => localStorage.getItem('token')!,
 *   useWorker: true,
 * }));
 */
export function createSharedWebSocketPlugin(url: string, options?: SharedWebSocketOptions) {
  return {
    install(app: App) {
      const socket = new SharedWebSocket(url, options);
      void socket.connect();
      app.provide(SharedWebSocketKey, socket);

      const originalUnmount = app.unmount.bind(app);
      app.unmount = () => {
        socket[Symbol.dispose]();
        originalUnmount();
      };
    },
  };
}

/**
 * Access the SharedWebSocket instance from provided context.
 *
 * @example
 * const ws = useSharedWebSocket();
 * ws.send('chat.message', { text: 'Hello' });
 */
export function useSharedWebSocket(): SharedWebSocket {
  const socket = inject(SharedWebSocketKey);
  if (!socket) {
    throw new Error('useSharedWebSocket: SharedWebSocket not provided. Did you install the plugin?');
  }
  return socket;
}
