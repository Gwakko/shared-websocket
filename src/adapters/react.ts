import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
  createElement,
} from 'react';
import { SharedWebSocket } from '../SharedWebSocket';
import type { SharedWebSocketOptions, TabRole, Unsubscribe } from '../types';

// ─── Context ─────────────────────────────────────────────

const SharedWSContext = createContext<SharedWebSocket | null>(null);

interface ProviderProps {
  children: ReactNode;
}

/**
 * Creates a SharedWebSocket instance with Provider and hook.
 *
 * @example
 * const { Provider, useSocket } = createSharedWebSocket('wss://api.example.com/ws');
 *
 * function App() {
 *   return <Provider><MyComponent /></Provider>;
 * }
 *
 * function MyComponent() {
 *   const ws = useSocket();
 *   // ...
 * }
 */
export function createSharedWebSocket(url: string, options?: SharedWebSocketOptions) {
  let instance: SharedWebSocket | null = null;

  function Provider({ children }: ProviderProps) {
    const [socket] = useState(() => {
      if (!instance) {
        instance = new SharedWebSocket(url, options);
        instance.connect();
      }
      return instance;
    });

    useEffect(() => {
      return () => {
        socket[Symbol.dispose]();
        instance = null;
      };
    }, [socket]);

    return createElement(SharedWSContext.Provider, { value: socket }, children);
  }

  function useSocket(): SharedWebSocket {
    const ctx = useContext(SharedWSContext);
    if (!ctx) throw new Error('useSocket must be used within SharedWebSocket Provider');
    return ctx;
  }

  return { Provider, useSocket };
}

// ─── Hooks ───────────────────────────────────────────────

/**
 * Subscribe to a WebSocket event. Returns the latest received value.
 *
 * @example
 * const order = useSocketEvent<Order>(ws, 'order.created');
 */
export function useSocketEvent<T>(socket: SharedWebSocket, event: string): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);

  useEffect(() => {
    const unsub = socket.on(event, (data: T) => setValue(data));
    return unsub;
  }, [socket, event]);

  return value;
}

/**
 * Accumulate WebSocket events into an array.
 *
 * @example
 * const messages = useSocketStream<ChatMessage>(ws, 'chat.message');
 */
export function useSocketStream<T>(socket: SharedWebSocket, event: string): T[] {
  const [items, setItems] = useState<T[]>([]);

  useEffect(() => {
    setItems([]);
    const unsub = socket.on(event, (data: T) => {
      setItems((prev) => [...prev, data]);
    });
    return unsub;
  }, [socket, event]);

  return items;
}

/**
 * Two-way state sync across browser tabs.
 *
 * @example
 * const [cart, setCart] = useSocketSync<Cart>(ws, 'cart', { items: [] });
 * // setCart in one tab → updates all tabs instantly
 */
export function useSocketSync<T>(
  socket: SharedWebSocket,
  key: string,
  initialValue: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    return socket.getSync<T>(key) ?? initialValue;
  });

  useEffect(() => {
    const unsub = socket.onSync<T>(key, setValue);
    return unsub;
  }, [socket, key]);

  const setAndSync = useCallback(
    (newValue: T) => {
      setValue(newValue);
      socket.sync(key, newValue);
    },
    [socket, key],
  );

  return [value, setAndSync];
}

/**
 * Reactive connection status.
 *
 * @example
 * const { connected, tabRole } = useSocketStatus(ws);
 */
export function useSocketStatus(socket: SharedWebSocket): {
  connected: boolean;
  tabRole: TabRole;
} {
  const [connected, setConnected] = useState(socket.connected);
  const [tabRole, setTabRole] = useState<TabRole>(socket.tabRole);

  useEffect(() => {
    const interval = setInterval(() => {
      setConnected(socket.connected);
      setTabRole(socket.tabRole);
    }, 1000);
    return () => clearInterval(interval);
  }, [socket]);

  return { connected, tabRole };
}
