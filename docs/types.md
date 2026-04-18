# Exported Types

All TypeScript types available for import, with examples for core, React, and Vue.

[← Back to README](../README.md)

## Table of Contents

- [Core Types](#core-types)
- [React Imports](#react-imports)
- [Vue Imports](#vue-imports)
- [Usage with Custom Types](#usage-with-custom-types)

## Core Types

```typescript
import type {
  // Core
  SharedWebSocketOptions,  // constructor options
  SocketState,             // 'connecting' | 'connected' | 'reconnecting' | 'closed'
  TabRole,                 // 'leader' | 'follower'
  Unsubscribe,             // () => void
  EventHandler,            // (data: any) => void

  // Channels
  Channel,                 // scoped channel handle from ws.channel()
  EventProtocol,           // custom event/field names

  // Lifecycle
  SocketLifecycleHandlers, // { onConnect?, onDisconnect?, onReconnecting?, ... }

  // withSocket
  SocketScope,             // { ws, signal } — callback argument
  WithSocketOptions,       // extends SharedWebSocketOptions + signal
  WithSocketCallback,      // (scope: SocketScope) => void | Promise<void>

  // Internal (advanced)
  BusMessage,              // BroadcastChannel message envelope
} from '@gwakko/shared-websocket';
```

## React Imports

```tsx
// React — all hooks + types
import {
  SharedWebSocketProvider,
  useSharedWebSocket,
  useAuth,
  useSocketEvent,
  useSocketStream,
  useSocketSync,
  useSocketCallback,
  useSocketStatus,
  useSocketLifecycle,
  useChannel,
  useTopics,
  usePush,
} from '@gwakko/shared-websocket/react';
```

## Vue Imports

```typescript
// Vue — all composables + types
import {
  createSharedWebSocketPlugin,
  useSharedWebSocket,
  useAuth,
  useSocketEvent,
  useSocketStream,
  useSocketSync,
  useSocketCallback,
  useSocketStatus,
  useSocketLifecycle,
  useChannel,
  useTopics,
  usePush,
  SharedWebSocketKey,
} from '@gwakko/shared-websocket/vue';
```

## Usage with Custom Types

```typescript
import type { Channel, SocketLifecycleHandlers, EventProtocol } from '@gwakko/shared-websocket';

// Type your channel
const chat: Channel = ws.channel('chat:room_1');

// Type lifecycle handlers separately
const handlers: SocketLifecycleHandlers = {
  onConnect: () => setStatus('online'),
  onDisconnect: () => setStatus('offline'),
};
useSocketLifecycle(handlers);

// Type your protocol config
const protocol: Partial<EventProtocol> = {
  eventField: 'type',
  dataField: 'payload',
  channelJoin: 'subscribe',
};
new SharedWebSocket(url, { events: protocol });
```
