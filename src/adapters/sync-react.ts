import {
  createContext,
  useContext,
  useEffect,
  useState,
  useEffectEvent,
  type ReactNode,
  createElement,
} from 'react';
import { TabSync } from '../TabSync';

// ─── Context ─────────────────────────────────────────────

const TabSyncContext = createContext<TabSync | null>(null);

/**
 * Provider for TabSync — creates instance, auto-disposes on unmount.
 *
 * @example
 * function App() {
 *   return (
 *     <TabSyncProvider channel="my-app">
 *       <Dashboard />
 *     </TabSyncProvider>
 *   );
 * }
 */
export interface TabSyncProviderProps {
  /** BroadcastChannel name (default: "tab-sync"). */
  channel?: string;
  children: ReactNode;
}

export function TabSyncProvider({ channel, children }: TabSyncProviderProps) {
  const [sync] = useState(() => new TabSync(channel));

  useEffect(() => {
    return () => sync[Symbol.dispose]();
  }, [sync]);

  return createElement(TabSyncContext.Provider, { value: sync }, children);
}

/**
 * Access the TabSync instance from context.
 *
 * @example
 * const sync = useTabSyncContext();
 * sync.set('theme', 'dark');
 */
export function useTabSyncContext(): TabSync {
  const ctx = useContext(TabSyncContext);
  if (!ctx) {
    throw new Error('useTabSync must be used within <TabSyncProvider>');
  }
  return ctx;
}

// ─── Hooks ───────────────────────────────────────────────

/**
 * Two-way state sync across browser tabs — like useState but shared.
 * - Without callback: returns [value, setter] synced across tabs.
 * - With callback: also calls your handler on every change (side effects).
 *
 * @example
 * // Shared state — updates propagate to all tabs
 * const [theme, setTheme] = useTabSync('theme', 'light');
 * <button onClick={() => setTheme('dark')}>Dark mode</button>
 *
 * @example
 * // With side effect callback
 * const [cart, setCart] = useTabSync('cart', { items: [] }, (cart) => {
 *   document.title = `Cart (${cart.items.length})`;
 * });
 *
 * @example
 * // Form state synced across tabs
 * const [draft, setDraft] = useTabSync('email-draft', '');
 * <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
 */
export function useTabSync<T>(
  key: string,
  initialValue: T,
  callback?: (value: T) => void,
): [T, (value: T) => void] {
  const sync = useTabSyncContext();
  const [value, setValue] = useState<T>(() => sync.get<T>(key) ?? initialValue);

  const onSync = useEffectEvent((synced: T) => {
    setValue(synced);
    callback?.(synced);
  });

  useEffect(() => {
    return sync.on<T>(key, onSync);
  }, [sync, key]);

  const setAndSync = useEffectEvent((newValue: T) => {
    setValue(newValue);
    sync.set(key, newValue);
  });

  return [value, setAndSync];
}

/**
 * Read-only subscription to a synced key. Returns undefined until first set.
 *
 * @example
 * const theme = useTabSyncValue<string>('theme');
 * <div className={theme === 'dark' ? 'dark' : 'light'} />
 */
export function useTabSyncValue<T>(key: string): T | undefined {
  const sync = useTabSyncContext();
  const [value, setValue] = useState<T | undefined>(() => sync.get<T>(key));

  const onSync = useEffectEvent((synced: T) => {
    setValue(synced);
  });

  useEffect(() => {
    return sync.on<T>(key, onSync);
  }, [sync, key]);

  return value;
}

/**
 * Fire-and-forget listener for a synced key. No state, no return value.
 *
 * @example
 * useTabSyncCallback<string>('theme', (theme) => {
 *   document.documentElement.setAttribute('data-theme', theme);
 * });
 *
 * @example
 * useTabSyncCallback<Cart>('cart', (cart) => {
 *   analytics.track('cart_updated', { count: cart.items.length });
 * });
 */
export function useTabSyncCallback<T>(key: string, callback: (value: T) => void): void {
  const sync = useTabSyncContext();

  const handler = useEffectEvent((value: T) => {
    callback(value);
  });

  useEffect(() => {
    return sync.on<T>(key, handler);
  }, [sync, key]);
}
