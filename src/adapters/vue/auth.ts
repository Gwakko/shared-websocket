import { ref, onUnmounted, readonly, type Ref } from 'vue';
import { useSharedWebSocket } from './plugin';

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
