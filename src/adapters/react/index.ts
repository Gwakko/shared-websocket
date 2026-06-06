// React 19 adapter — provider + hooks for SharedWebSocket.
// Split by concern; this barrel preserves the public `@gwakko/shared-websocket/react` surface.
export {
  SharedWebSocketProvider,
  useSharedWebSocket,
  useSharedWebSocketOrThrow,
  type SharedWebSocketProviderProps,
} from './context';
export { useSocketAuth } from './auth';
export { useSocketEvent, useSocketStream, useSocketCallback } from './events';
export { useSocketSync } from './state';
export { useSocketStatus, useSocketLifecycle, useSocketReconnect } from './status';
export { useChannel, useTopics, usePush } from './subscriptions';
