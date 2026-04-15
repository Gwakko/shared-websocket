import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useEffectEvent,
  type ReactNode,
  createElement,
} from 'react';
import { SharedWebSocket } from '../SharedWebSocket';
import type { SharedWebSocketOptions, TabRole, SocketLifecycleHandlers, EventHandler } from '../types';

// ─── Context ─────────────────────────────────────────────

const SharedWSContext = createContext<SharedWebSocket | null>(null);

/**
 * Provider props — pass URL and options as props for flexibility.
 *
 * @example
 * <SharedWebSocketProvider url="wss://api.example.com/ws" options={{ auth: getToken }}>
 *   <App />
 * </SharedWebSocketProvider>
 */
export interface SharedWebSocketProviderProps {
  url: string;
  options?: SharedWebSocketOptions;
  children: ReactNode;
}

/**
 * Provider component — creates SharedWebSocket from props, auto-disposes on unmount.
 *
 * @example
 * function App() {
 *   return (
 *     <SharedWebSocketProvider
 *       url="wss://api.example.com/ws"
 *       options={{
 *         auth: () => localStorage.getItem('token')!,
 *         useWorker: true,
 *       }}
 *     >
 *       <Dashboard />
 *     </SharedWebSocketProvider>
 *   );
 * }
 */
export function SharedWebSocketProvider({ url, options, children }: SharedWebSocketProviderProps) {
  const [socket] = useState(() => {
    const ws = new SharedWebSocket(url, options);
    ws.connect();
    return ws;
  });

  useEffect(() => {
    return () => {
      socket[Symbol.dispose]();
    };
  }, [socket]);

  return createElement(SharedWSContext.Provider, { value: socket }, children);
}

/**
 * Access the SharedWebSocket instance from context.
 *
 * @example
 * const ws = useSharedWebSocket();
 * ws.send('chat.message', { text: 'Hello' });
 */
export function useSharedWebSocket(): SharedWebSocket {
  const ctx = useContext(SharedWSContext);
  if (!ctx) {
    throw new Error('useSharedWebSocket must be used within <SharedWebSocketProvider>');
  }
  return ctx;
}

// ─── Hooks ───────────────────────────────────────────────

/**
 * Subscribe to a WebSocket event.
 * - Without callback: returns the latest received value (reactive state).
 * - With callback: calls your handler on each event (stable ref via useEffectEvent).
 *
 * @example
 * // Reactive state — returns latest value
 * const order = useSocketEvent<Order>('order.created');
 *
 * @example
 * // Custom callback — full control, no state
 * useSocketEvent<Order>('order.created', (order) => {
 *   playSound('new-order');
 *   analytics.track('order_received', order);
 * });
 *
 * @example
 * // Custom callback with transform — store in your own state
 * const [orders, setOrders] = useState<Order[]>([]);
 * useSocketEvent<Order>('order.created', (order) => {
 *   setOrders(prev => [order, ...prev].slice(0, 50)); // keep last 50
 * });
 */
export function useSocketEvent<T>(event: string, callback?: (data: T) => void): T | undefined {
  const socket = useSharedWebSocket();
  const [value, setValue] = useState<T | undefined>(undefined);

  const onEvent = useEffectEvent((data: T) => {
    if (callback) {
      callback(data);
    } else {
      setValue(data);
    }
  });

  useEffect(() => {
    const unsub = socket.on(event, onEvent as EventHandler);
    return unsub;
  }, [socket, event]);

  return callback ? undefined : value;
}

/**
 * Accumulate WebSocket events into an array.
 * - Without callback: returns accumulated array (reactive state).
 * - With callback: calls your handler on each event, you manage your own state.
 *
 * @example
 * // Default — accumulates all events
 * const messages = useSocketStream<ChatMessage>('chat.message');
 *
 * @example
 * // Custom callback — keep only last 50, transform, filter, etc.
 * const [messages, setMessages] = useState<ChatMessage[]>([]);
 * useSocketStream<ChatMessage>('chat.message', (msg) => {
 *   setMessages(prev => [msg, ...prev].slice(0, 50));
 * });
 *
 * @example
 * // Custom callback — filter by type
 * const [errors, setErrors] = useState<LogEntry[]>([]);
 * useSocketStream<LogEntry>('log.entry', (entry) => {
 *   if (entry.level === 'error') setErrors(prev => [...prev, entry]);
 * });
 */
export function useSocketStream<T>(event: string, callback?: (data: T) => void): T[] {
  const socket = useSharedWebSocket();
  const [items, setItems] = useState<T[]>([]);

  const onEvent = useEffectEvent((data: T) => {
    if (callback) {
      callback(data);
    } else {
      setItems((prev) => [...prev, data]);
    }
  });

  useEffect(() => {
    if (!callback) setItems([]);
    const unsub = socket.on(event, onEvent as EventHandler);
    return unsub;
  }, [socket, event]);

  return callback ? [] : items;
}

/**
 * Two-way state sync across browser tabs.
 * - Without callback: returns [value, setter] (like useState but synced).
 * - With callback: calls your handler when any tab updates this key.
 *
 * @example
 * // Default — reactive synced state
 * const [cart, setCart] = useSocketSync<Cart>('cart', { items: [] });
 *
 * @example
 * // Custom callback — side effects on sync
 * const [cart, setCart] = useSocketSync<Cart>('cart', { items: [] }, (cart) => {
 *   document.title = `Cart (${cart.items.length})`;
 *   analytics.track('cart_updated', { count: cart.items.length });
 * });
 */
export function useSocketSync<T>(
  key: string,
  initialValue: T,
  callback?: (value: T) => void,
): [T, (value: T) => void] {
  const socket = useSharedWebSocket();
  const [value, setValue] = useState<T>(() => {
    return socket.getSync<T>(key) ?? initialValue;
  });

  const onSync = useEffectEvent((synced: T) => {
    setValue(synced);
    callback?.(synced);
  });

  useEffect(() => {
    const unsub = socket.onSync<T>(key, onSync);
    return unsub;
  }, [socket, key]);

  const setAndSync = useEffectEvent((newValue: T) => {
    setValue(newValue);
    socket.sync(key, newValue);
  });

  return [value, setAndSync];
}

/**
 * Subscribe to a WebSocket event with just a callback — no state, no return value.
 * Fire-and-forget: side effects, logging, analytics, sounds, browser notifications.
 * Stable ref via useEffectEvent — callback always sees latest closure values.
 *
 * @example
 * useSocketCallback<Order>('order.created', (order) => {
 *   playSound('new-order');
 *   analytics.track('order_received', { id: order.id });
 * });
 *
 * @example
 * // Browser notification only from leader tab
 * useSocketCallback<Notification>('notification', (notif) => {
 *   if (ws.tabRole === 'leader' && document.hidden) {
 *     new Notification(notif.title, { body: notif.body });
 *   }
 * });
 */
export function useSocketCallback<T>(event: string, callback: (data: T) => void): void {
  const socket = useSharedWebSocket();

  const handler = useEffectEvent((data: T) => {
    callback(data);
  });

  useEffect(() => {
    const unsub = socket.on(event, handler as EventHandler);
    return unsub;
  }, [socket, event]);
}

/**
 * Reactive connection status.
 * Uses useEffectEvent to avoid re-creating interval on state change.
 *
 * @example
 * const { connected, tabRole } = useSocketStatus();
 */
export function useSocketStatus(): {
  connected: boolean;
  tabRole: TabRole;
} {
  const socket = useSharedWebSocket();
  const [connected, setConnected] = useState(socket.connected);
  const [tabRole, setTabRole] = useState<TabRole>(socket.tabRole);

  const tick = useEffectEvent(() => {
    setConnected(socket.connected);
    setTabRole(socket.tabRole);
  });

  useEffect(() => {
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [socket]);

  return { connected, tabRole };
}

/**
 * Lifecycle hooks — react to connection state changes.
 *
 * @example
 * useSocketLifecycle({
 *   onConnect: () => console.log('Connected!'),
 *   onDisconnect: () => console.log('Disconnected'),
 *   onReconnecting: () => showSpinner(),
 *   onLeaderChange: (isLeader) => console.log('Leader:', isLeader),
 *   onError: (err) => reportError(err),
 * });
 */
export function useSocketLifecycle(handlers: SocketLifecycleHandlers): void {
  const socket = useSharedWebSocket();

  const onConnect = useEffectEvent(() => handlers.onConnect?.());
  const onDisconnect = useEffectEvent(() => handlers.onDisconnect?.());
  const onReconnecting = useEffectEvent(() => handlers.onReconnecting?.());
  const onLeaderChange = useEffectEvent((isLeader: boolean) => handlers.onLeaderChange?.(isLeader));
  const onError = useEffectEvent((error: unknown) => handlers.onError?.(error));
  const onActive = useEffectEvent(() => handlers.onActive?.());
  const onInactive = useEffectEvent(() => handlers.onInactive?.());
  const onVisibilityChange = useEffectEvent((isActive: boolean) => handlers.onVisibilityChange?.(isActive));

  useEffect(() => {
    const unsubs = [
      socket.onConnect(onConnect),
      socket.onDisconnect(onDisconnect),
      socket.onReconnecting(onReconnecting),
      socket.onLeaderChange(onLeaderChange),
      socket.onError(onError),
      socket.onActive(onActive),
      socket.onInactive(onInactive),
      socket.onVisibilityChange(onVisibilityChange),
    ];
    return () => unsubs.forEach((u) => u());
  }, [socket]);
}

/**
 * Subscribe to a private channel. Auto-joins on mount, leaves on unmount.
 *
 * @example
 * const chat = useChannel('chat:room_123');
 * const message = useSocketEvent('chat:room_123:message');
 * chat.send('message', { text: 'Hello' });
 *
 * @example
 * // Tenant notifications
 * const notifications = useChannel(`tenant:${tenantId}:notifications`);
 * useSocketCallback(`tenant:${tenantId}:notifications:alert`, showToast);
 */
export function useChannel(name: string) {
  const socket = useSharedWebSocket();
  const channelRef = useRef(socket.channel(name));

  useEffect(() => {
    channelRef.current = socket.channel(name);
    return () => channelRef.current.leave();
  }, [socket, name]);

  return channelRef.current;
}

/**
 * Subscribe to server-side topics. Auto-unsubscribes on unmount.
 *
 * @example
 * useTopics(['notifications:orders', 'notifications:payments']);
 * useTopics([`user:${userId}:mentions`]);
 */
export function useTopics(topics: string[]): void {
  const socket = useSharedWebSocket();

  useEffect(() => {
    topics.forEach((t) => socket.subscribe(t));
    return () => topics.forEach((t) => socket.unsubscribe(t));
  }, [socket, topics.join(',')]);
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
 *
 * @example
 * usePush('order.created', {
 *   title: (order) => `New Order #${order.id}`,
 *   body: (order) => `$${order.total}`,
 *   onClick: (order) => navigate(`/orders/${order.id}`),
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
    const unsub = socket.push<T>(event, config);
    return unsub;
  }, [socket, event]);
}
