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
import { TabSync } from '../TabSync';

// ─── Plugin ──────────────────────────────────────────────

export const TabSyncKey: InjectionKey<TabSync> = Symbol('TabSync');

/**
 * Vue 3 plugin for TabSync.
 *
 * @example
 * const app = createApp(App);
 * app.use(createTabSyncPlugin('my-app'));
 */
export function createTabSyncPlugin(channel?: string) {
  return {
    install(app: App) {
      const sync = new TabSync(channel);
      app.provide(TabSyncKey, sync);

      const originalUnmount = app.unmount.bind(app);
      app.unmount = () => {
        sync[Symbol.dispose]();
        originalUnmount();
      };
    },
  };
}

/**
 * Access the TabSync instance from provided context.
 *
 * @example
 * const sync = useTabSyncContext();
 * sync.set('theme', 'dark');
 */
export function useTabSyncContext(): TabSync {
  const sync = inject(TabSyncKey);
  if (!sync) {
    throw new Error('useTabSync: TabSync not provided. Did you install the plugin?');
  }
  return sync;
}

// ─── Composables ─────────────────────────────────────────

/**
 * Two-way reactive state synced across tabs.
 * Mutating the ref broadcasts the change; changes from other tabs update the ref.
 *
 * @example
 * const theme = useTabSync('theme', 'light');
 * theme.value = 'dark'; // syncs to all tabs
 *
 * @example
 * // With side effect callback
 * const cart = useTabSync('cart', { items: [] }, (cart) => {
 *   document.title = `Cart (${cart.items.length})`;
 * });
 * cart.value = { items: [...cart.value.items, newItem] };
 *
 * @example
 * // Form draft synced across tabs
 * const draft = useTabSync('email-draft', '');
 * // <textarea v-model="draft" />
 */
export function useTabSync<T>(key: string, initialValue: T, callback?: (value: T) => void): Ref<T> {
  const sync = useTabSyncContext();
  const value = ref<T>(sync.get<T>(key) ?? initialValue) as Ref<T>;

  const unsub = sync.on<T>(key, (v) => {
    value.value = v;
    callback?.(v);
  });

  watch(
    value,
    (newVal) => {
      sync.set(key, newVal);
    },
    { deep: true },
  );

  onUnmounted(unsub);
  return value;
}

/**
 * Read-only subscription to a synced key. Returns undefined until first set.
 *
 * @example
 * const theme = useTabSyncValue<string>('theme');
 * // <div :class="theme === 'dark' ? 'dark' : 'light'" />
 */
export function useTabSyncValue<T>(key: string): Ref<T | undefined> {
  const sync = useTabSyncContext();
  const value = ref<T | undefined>(sync.get<T>(key)) as Ref<T | undefined>;

  const unsub = sync.on<T>(key, (v) => {
    value.value = v;
  });

  onUnmounted(unsub);
  return readonly(value) as Ref<T | undefined>;
}

/**
 * Fire-and-forget listener for a synced key. No ref, no return value.
 *
 * @example
 * useTabSyncCallback<string>('theme', (theme) => {
 *   document.documentElement.setAttribute('data-theme', theme);
 * });
 */
export function useTabSyncCallback<T>(key: string, callback: (value: T) => void): void {
  const sync = useTabSyncContext();
  const unsub = sync.on<T>(key, callback);
  onUnmounted(unsub);
}
