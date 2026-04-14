import {
  createContext,
  useContext,
  useEffect,
  useState,
  useEffectEvent,
  type ReactNode,
  createElement,
} from 'react';
import { SharedWebSocket } from '../SharedWebSocket';
import type { SharedWebSocketOptions, TabRole } from '../types';

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
    const unsub = socket.on(event, onEvent);
    return unsub;
  }, [socket, event]);

  return callback ? undefined : value;
}

/**
 * Accumulate WebSocket events into an array.
 * Uses useEffectEvent — handler always sees latest state without re-subscribing.
 *
 * @example
 * const messages = useSocketStream<ChatMessage>('chat.message');
 */
export function useSocketStream<T>(event: string): T[] {
  const socket = useSharedWebSocket();
  const [items, setItems] = useState<T[]>([]);

  const onEvent = useEffectEvent((data: T) => {
    setItems((prev) => [...prev, data]);
  });

  useEffect(() => {
    setItems([]);
    const unsub = socket.on(event, onEvent);
    return unsub;
  }, [socket, event]);

  return items;
}

/**
 * Two-way state sync across browser tabs.
 * Uses useEffectEvent for stable sync callback.
 *
 * @example
 * const [cart, setCart] = useSocketSync<Cart>('cart', { items: [] });
 * // setCart in one tab → updates all tabs instantly
 */
export function useSocketSync<T>(
  key: string,
  initialValue: T,
): [T, (value: T) => void] {
  const socket = useSharedWebSocket();
  const [value, setValue] = useState<T>(() => {
    return socket.getSync<T>(key) ?? initialValue;
  });

  const onSync = useEffectEvent((synced: T) => {
    setValue(synced);
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
    const unsub = socket.on(event, handler);
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
