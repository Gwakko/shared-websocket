// Vue 3 adapter — plugin + composables for SharedWebSocket.
// Split by concern; this barrel preserves the public `@gwakko/shared-websocket/vue` surface.
export { SharedWebSocketKey, createSharedWebSocketPlugin, useSharedWebSocket } from './plugin';
export { useSocketAuth } from './auth';
export { useSocketEvent, useSocketStream, useSocketCallback } from './events';
export { useSocketSync } from './state';
export { useSocketStatus, useSocketLifecycle, useSocketReconnect } from './status';
export { useChannel, useTopics, usePush } from './subscriptions';
