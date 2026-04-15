// Core
export { SharedWebSocket } from './SharedWebSocket';
export { withSocket } from './withSocket';

// Internal components (for advanced usage)
export { MessageBus } from './MessageBus';
export { TabCoordinator } from './TabCoordinator';
export { SharedSocket } from './SharedSocket';
export { WorkerSocket } from './WorkerSocket';
export { SubscriptionManager } from './SubscriptionManager';

// Types
export type { WithSocketCallback, WithSocketOptions, SocketScope } from './withSocket';
export type {
  SharedWebSocketOptions,
  SocketState,
  TabRole,
  Unsubscribe,
  EventHandler,
  Channel,
  EventProtocol,
  BusMessage,
  SocketLifecycleHandlers,
} from './types';
