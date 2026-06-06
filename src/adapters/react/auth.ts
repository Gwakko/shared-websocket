import { useEffect, useState, useEffectEvent } from 'react';
import { useSharedWebSocket } from './context';

/**
 * Reactive auth state with authenticate/deauthenticate actions.
 * Syncs across all tabs via BroadcastChannel. No-ops while the socket is null.
 *
 * @example
 * function Header() {
 *   const { isAuthenticated, deauthenticate } = useSocketAuth();
 *   return isAuthenticated
 *     ? <button onClick={deauthenticate}>Logout</button>
 *     : <Link to="/login">Login</Link>;
 * }
 */
export function useSocketAuth(): {
  isAuthenticated: boolean;
  authenticate: (token: string) => void;
  deauthenticate: () => void;
} {
  const socket = useSharedWebSocket();
  const [isAuthenticated, setIsAuthenticated] = useState(() => socket?.isAuthenticated ?? false);

  const onAuthChange = useEffectEvent((authenticated: boolean) => {
    setIsAuthenticated(authenticated);
  });

  useEffect(() => {
    if (!socket) return;
    setIsAuthenticated(socket.isAuthenticated); // sync current state when the socket attaches
    return socket.onAuthChange(onAuthChange);
  }, [socket]);

  const authenticate = useEffectEvent((token: string) => {
    socket?.authenticate(token);
  });

  const deauthenticate = useEffectEvent(() => {
    socket?.deauthenticate();
  });

  return { isAuthenticated, authenticate, deauthenticate };
}
