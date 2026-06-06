import {
  createContext,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  createElement,
} from 'react';
import { SharedWebSocket } from '../../SharedWebSocket';
import type { SharedWebSocketOptions } from '../../types';

// ─── Context ─────────────────────────────────────────────

const SharedWSContext = createContext<SharedWebSocket | null>(null);

/**
 * Per-provider store that owns a single SharedWebSocket. The instance is born
 * on the first subscriber (commit-time, never during a render) and torn down
 * when the last subscriber leaves — so there is exactly one instance per
 * provider, and a render that React throws away never constructs anything.
 */
interface SocketStore {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => SharedWebSocket | null;
  getServerSnapshot: () => null;
}

function createSocketStore(url: string, options?: SharedWebSocketOptions): SocketStore {
  let socket: SharedWebSocket | null = null;
  const listeners = new Set<() => void>();

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      if (!socket) {
        socket = new SharedWebSocket(url, options);
        void socket.connect();
        listeners.forEach((l) => l());
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
          socket?.[Symbol.dispose]();
          socket = null;
        }
      };
    },
    getSnapshot: () => socket,
    getServerSnapshot: () => null,
  };
}

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
 * Provider component — owns one SharedWebSocket for its lifetime via an external
 * store. The instance is created on mount (connect runs once) and disposed on
 * unmount. `useSharedWebSocket()` is `null` until the instance exists.
 */
export function SharedWebSocketProvider({ url, options, children }: SharedWebSocketProviderProps) {
  // One store per provider. Locked to the first url/options — remount the
  // provider (e.g. via a `key`) to target a different endpoint.
  const storeRef = useRef<SocketStore | null>(null);
  storeRef.current ??= createSocketStore(url, options);

  const socket = useSyncExternalStore(
    storeRef.current.subscribe,
    storeRef.current.getSnapshot,
    storeRef.current.getServerSnapshot,
  );

  return createElement(SharedWSContext.Provider, { value: socket }, children);
}

/**
 * Access the SharedWebSocket instance from context. Returns `null` until the
 * provider's instance is connected (first render and SSR). Feature hooks
 * (`useSocketEvent`, `useChannel`, …) handle the null internally; for imperative
 * call sites that need the instance, use {@link useSharedWebSocketOrThrow}.
 *
 * @example
 * const ws = useSharedWebSocket();
 * if (ws) ws.send('chat.message', { text: 'Hello' });
 */
export function useSharedWebSocket(): SharedWebSocket | null {
  return useContext(SharedWSContext);
}

/**
 * Like {@link useSharedWebSocket} but asserts the instance exists. Use only at
 * imperative call sites that run after the provider has mounted (event handlers,
 * effects) — calling it during the first render will throw, since the socket is
 * not created until commit.
 *
 * @example
 * function SendButton() {
 *   const ws = useSharedWebSocketOrThrow();
 *   return <button onClick={() => ws.send('ping', {})}>Ping</button>;
 * }
 */
export function useSharedWebSocketOrThrow(): SharedWebSocket {
  const socket = useContext(SharedWSContext);
  if (!socket) {
    throw new Error(
      'useSharedWebSocketOrThrow: no connected SharedWebSocket. It is null until the provider mounts — ' +
        'use it in event handlers/effects, or call useSharedWebSocket() and handle null.',
    );
  }
  return socket;
}
