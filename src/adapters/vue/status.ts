import { ref, onUnmounted, readonly, type Ref } from 'vue';
import { useSharedWebSocket } from './plugin';
import type { TabRole, SocketLifecycleHandlers } from '../../types';

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
  if (handlers.onReconnectFailed) unsubs.push(socket.onReconnectFailed(handlers.onReconnectFailed));
  if (handlers.onLeaderChange) unsubs.push(socket.onLeaderChange(handlers.onLeaderChange));
  if (handlers.onError) unsubs.push(socket.onError(handlers.onError));
  if (handlers.onActive) unsubs.push(socket.onActive(handlers.onActive));
  if (handlers.onInactive) unsubs.push(socket.onInactive(handlers.onInactive));
  if (handlers.onVisibilityChange) unsubs.push(socket.onVisibilityChange(handlers.onVisibilityChange));
  if (handlers.onAuthChange) unsubs.push(socket.onAuthChange(handlers.onAuthChange));

  onUnmounted(() => unsubs.forEach((u) => u()));
}

/**
 * Reactive reconnect state with a manual `reconnect` action. Use this to
 * power a "Reconnect" snackbar/banner after auto-reconnect gives up.
 *
 * `hasFailed` flips to `true` once `reconnectMaxRetries` are exhausted, and
 * back to `false` once the connection succeeds or the user calls `reconnect()`.
 *
 * @example
 * <script setup>
 * const { hasFailed, reconnect } = useSocketReconnect();
 * </script>
 *
 * <template>
 *   <div v-if="hasFailed" class="snackbar">
 *     Connection lost.
 *     <button @click="reconnect">Reconnect</button>
 *   </div>
 * </template>
 */
export function useSocketReconnect(): {
  hasFailed: Ref<boolean>;
  reconnect: () => void;
} {
  const socket = useSharedWebSocket();
  const hasFailed = ref(false);

  const unsubs = [
    socket.onReconnectFailed(() => {
      hasFailed.value = true;
    }),
    socket.onConnect(() => {
      hasFailed.value = false;
    }),
  ];

  onUnmounted(() => unsubs.forEach((u) => u()));

  return {
    hasFailed: readonly(hasFailed) as Ref<boolean>,
    reconnect: () => {
      hasFailed.value = false;
      socket.reconnect();
    },
  };
}
