import { useEffect, useState, useEffectEvent } from 'react';
import { useSharedWebSocket } from './context';
import type { TabRole, SocketLifecycleHandlers } from '../../types';

/**
 * Reactive connection status. Reports `false`/`'follower'` while the socket is
 * null, then tracks the live instance once it is ready.
 *
 * @example
 * const { connected, tabRole } = useSocketStatus();
 */
export function useSocketStatus(): {
  connected: boolean;
  tabRole: TabRole;
  isAuthenticated: boolean;
} {
  const socket = useSharedWebSocket();
  const [connected, setConnected] = useState(() => socket?.connected ?? false);
  const [tabRole, setTabRole] = useState<TabRole>(() => socket?.tabRole ?? 'follower');
  const [isAuthenticated, setIsAuthenticated] = useState(() => socket?.isAuthenticated ?? false);

  const tick = useEffectEvent(() => {
    setConnected(socket?.connected ?? false);
    setTabRole(socket?.tabRole ?? 'follower');
    setIsAuthenticated(socket?.isAuthenticated ?? false);
  });

  useEffect(() => {
    if (!socket) return;
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [socket]);

  return { connected, tabRole, isAuthenticated };
}

/**
 * Lifecycle hooks — react to connection state changes. Wires up once the socket
 * is ready (no-op while null).
 *
 * @example
 * useSocketLifecycle({
 *   onConnect: () => console.log('Connected!'),
 *   onError: (err) => reportError(err),
 * });
 */
export function useSocketLifecycle(handlers: SocketLifecycleHandlers): void {
  const socket = useSharedWebSocket();

  const onConnect = useEffectEvent(() => handlers.onConnect?.());
  const onDisconnect = useEffectEvent(() => handlers.onDisconnect?.());
  const onReconnecting = useEffectEvent(() => handlers.onReconnecting?.());
  const onReconnectFailed = useEffectEvent(() => handlers.onReconnectFailed?.());
  const onLeaderChange = useEffectEvent((isLeader: boolean) => handlers.onLeaderChange?.(isLeader));
  const onError = useEffectEvent((error: unknown) => handlers.onError?.(error));
  const onActive = useEffectEvent(() => handlers.onActive?.());
  const onInactive = useEffectEvent(() => handlers.onInactive?.());
  const onVisibilityChange = useEffectEvent((isActive: boolean) => handlers.onVisibilityChange?.(isActive));
  const onAuthChange = useEffectEvent((authenticated: boolean) => handlers.onAuthChange?.(authenticated));

  useEffect(() => {
    if (!socket) return;
    const unsubs = [
      socket.onConnect(onConnect),
      socket.onDisconnect(onDisconnect),
      socket.onReconnecting(onReconnecting),
      socket.onReconnectFailed(onReconnectFailed),
      socket.onLeaderChange(onLeaderChange),
      socket.onError(onError),
      socket.onActive(onActive),
      socket.onInactive(onInactive),
      socket.onVisibilityChange(onVisibilityChange),
      socket.onAuthChange(onAuthChange),
    ];
    return () => unsubs.forEach((u) => u());
  }, [socket]);
}

/**
 * Reactive reconnect state with a manual `reconnect` action. Use this to
 * power a "Reconnect" snackbar/banner after auto-reconnect gives up.
 *
 * @example
 * const { hasFailed, reconnect } = useSocketReconnect();
 */
export function useSocketReconnect(): {
  hasFailed: boolean;
  reconnect: () => void;
} {
  const socket = useSharedWebSocket();
  const [hasFailed, setHasFailed] = useState(false);

  const onFailed = useEffectEvent(() => setHasFailed(true));
  const onConnected = useEffectEvent(() => setHasFailed(false));

  useEffect(() => {
    if (!socket) return;
    const unsubs = [
      socket.onReconnectFailed(onFailed),
      socket.onConnect(onConnected),
    ];
    return () => unsubs.forEach((u) => u());
  }, [socket]);

  const reconnect = useEffectEvent(() => {
    setHasFailed(false);
    socket?.reconnect();
  });

  return { hasFailed, reconnect };
}
