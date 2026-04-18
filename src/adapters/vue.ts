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
import type { SharedWebSocketOptions, TabRole, SocketLifecycleHandlers } from '../types';

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
      socket.connect();
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

/**
 * Reactive auth state with authenticate/deauthenticate actions.
 * Syncs across all tabs.
 *
 * @example
 * const { isAuthenticated, authenticate, deauthenticate } = useSocketAuth();
 *
 * async function login(email: string, password: string) {
 *   const { token } = await api.login(email, password);
 *   authenticate(token);
 * }
 *
 * @example
 * // In template: <button v-if="isAuthenticated" @click="deauthenticate">Logout</button>
 */
export function useSocketAuth(): {
  isAuthenticated: Ref<boolean>;
  authenticate: (token: string) => void;
  deauthenticate: () => void;
} {
  const socket = useSharedWebSocket();
  const isAuthenticated = ref(socket.isAuthenticated);

  const unsub = socket.onAuthChange((authenticated: boolean) => {
    isAuthenticated.value = authenticated;
  });

  onUnmounted(unsub);

  return {
    isAuthenticated: readonly(isAuthenticated) as Ref<boolean>,
    authenticate: (token: string) => socket.authenticate(token),
    deauthenticate: () => socket.deauthenticate(),
  };
}

// ─── Composables ─────────────────────────────────────────

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
export function useSocketEvent<T>(event: string, callback?: (data: T) => void): Ref<T | undefined> {
  const socket = useSharedWebSocket();
  const value = ref<T | undefined>(undefined) as Ref<T | undefined>;

  const handler = (data: unknown) => {
    const typed = data as T;
    if (callback) {
      callback(typed);
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
export function useSocketStream<T>(event: string, callback?: (data: T) => void): Ref<T[]> {
  const socket = useSharedWebSocket();
  const items = ref<T[]>([]) as Ref<T[]>;

  const handler = (data: unknown) => {
    const typed = data as T;
    if (callback) {
      callback(typed);
    } else {
      items.value = [...items.value, typed];
    }
  };
  const unsub = socket.on(event, handler);

  onUnmounted(unsub);
  return readonly(items) as Ref<T[]>;
}

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

/**
 * Fire-and-forget event handler — no state, no ref.
 *
 * @example
 * useSocketCallback<Notification>('notification', (n) => {
 *   showToast(n.title);
 * });
 */
export function useSocketCallback<T>(event: string, callback: (data: T) => void): void {
  const socket = useSharedWebSocket();

  const unsub = socket.on(event, (data: unknown) => {
    callback(data as T);
  });

  onUnmounted(unsub);
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
  isAuthenticated: Ref<boolean>;
} {
  const socket = useSharedWebSocket();
  const connected = ref(socket.connected);
  const tabRole = ref<TabRole>(socket.tabRole);
  const isAuthenticated = ref(socket.isAuthenticated);

  const timer = setInterval(() => {
    connected.value = socket.connected;
    tabRole.value = socket.tabRole;
    isAuthenticated.value = socket.isAuthenticated;
  }, 1000);

  onUnmounted(() => clearInterval(timer));

  return {
    connected: readonly(connected) as Ref<boolean>,
    tabRole: readonly(tabRole) as Ref<TabRole>,
    isAuthenticated: readonly(isAuthenticated) as Ref<boolean>,
  };
}

/**
 * Lifecycle hooks — react to connection state changes.
 *
 * @example
 * useSocketLifecycle({
 *   onConnect: () => console.log('Connected!'),
 *   onDisconnect: () => showOfflineBanner(),
 *   onReconnecting: () => showSpinner(),
 *   onLeaderChange: (isLeader) => console.log('Leader:', isLeader),
 *   onError: (err) => reportError(err),
 * });
 */
export function useSocketLifecycle(handlers: SocketLifecycleHandlers): void {
  const socket = useSharedWebSocket();
  const unsubs: (() => void)[] = [];

  if (handlers.onConnect) unsubs.push(socket.onConnect(handlers.onConnect));
  if (handlers.onDisconnect) unsubs.push(socket.onDisconnect(handlers.onDisconnect));
  if (handlers.onReconnecting) unsubs.push(socket.onReconnecting(handlers.onReconnecting));
  if (handlers.onLeaderChange) unsubs.push(socket.onLeaderChange(handlers.onLeaderChange));
  if (handlers.onError) unsubs.push(socket.onError(handlers.onError));
  if (handlers.onActive) unsubs.push(socket.onActive(handlers.onActive));
  if (handlers.onInactive) unsubs.push(socket.onInactive(handlers.onInactive));
  if (handlers.onVisibilityChange) unsubs.push(socket.onVisibilityChange(handlers.onVisibilityChange));
  if (handlers.onAuthChange) unsubs.push(socket.onAuthChange(handlers.onAuthChange));

  onUnmounted(() => unsubs.forEach((u) => u()));
}

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
