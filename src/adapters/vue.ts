import {
  ref,
  onUnmounted,
  inject,
  readonly,
  watch,
  type Ref,
  type InjectionKey,
  type App,
} from 'vue';
import { SharedWebSocket } from '../SharedWebSocket';
import type { SharedWebSocketOptions, TabRole } from '../types';

// ─── Plugin ──────────────────────────────────────────────

export const SharedWebSocketKey: InjectionKey<SharedWebSocket> = Symbol('SharedWebSocket');

/**
 * Vue 3 plugin for SharedWebSocket.
 *
 * @example
 * const app = createApp(App);
 * app.use(createSharedWebSocketPlugin('wss://api.example.com/ws'));
 */
export function createSharedWebSocketPlugin(url: string, options?: SharedWebSocketOptions) {
  return {
    install(app: App) {
      const socket = new SharedWebSocket(url, options);
      socket.connect();
      app.provide(SharedWebSocketKey, socket);

      // Cleanup on app unmount
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
 */
export function useSharedWebSocket(): SharedWebSocket {
  const socket = inject(SharedWebSocketKey);
  if (!socket) {
    throw new Error('useSharedWebSocket: SharedWebSocket not provided. Did you install the plugin?');
  }
  return socket;
}

// ─── Composables ─────────────────────────────────────────

/**
 * Subscribe to a WebSocket event. Returns reactive ref with latest value.
 *
 * @example
 * const order = useSocketEvent<Order>('order.created');
 */
export function useSocketEvent<T>(event: string): Ref<T | undefined> {
  const socket = useSharedWebSocket();
  const value = ref<T | undefined>(undefined) as Ref<T | undefined>;

  const unsub = socket.on(event, (data: T) => {
    value.value = data;
  });

  onUnmounted(unsub);
  return readonly(value) as Ref<T | undefined>;
}

/**
 * Accumulate WebSocket events into reactive array.
 *
 * @example
 * const messages = useSocketStream<ChatMessage>('chat.message');
 */
export function useSocketStream<T>(event: string): Ref<T[]> {
  const socket = useSharedWebSocket();
  const items = ref<T[]>([]) as Ref<T[]>;

  const unsub = socket.on(event, (data: T) => {
    items.value = [...items.value, data];
  });

  onUnmounted(unsub);
  return readonly(items) as Ref<T[]>;
}

/**
 * Two-way state sync across browser tabs via reactive ref.
 *
 * @example
 * const cart = useSocketSync<Cart>('cart', { items: [] });
 * cart.value = { items: [1, 2, 3] }; // syncs to all tabs
 */
export function useSocketSync<T>(key: string, initialValue: T): Ref<T> {
  const socket = useSharedWebSocket();
  const value = ref<T>(socket.getSync<T>(key) ?? initialValue) as Ref<T>;

  const unsub = socket.onSync<T>(key, (v) => {
    value.value = v;
  });

  // Watch for local changes → sync to other tabs
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

/**
 * Reactive connection status.
 *
 * @example
 * const { connected, tabRole } = useSocketStatus();
 */
export function useSocketStatus(): {
  connected: Ref<boolean>;
  tabRole: Ref<TabRole>;
} {
  const socket = useSharedWebSocket();
  const connected = ref(socket.connected);
  const tabRole = ref<TabRole>(socket.tabRole);

  let timer: ReturnType<typeof setInterval>;

  timer = setInterval(() => {
    connected.value = socket.connected;
    tabRole.value = socket.tabRole;
  }, 1000);

  onUnmounted(() => clearInterval(timer));

  return {
    connected: readonly(connected) as Ref<boolean>,
    tabRole: readonly(tabRole) as Ref<TabRole>,
  };
}
