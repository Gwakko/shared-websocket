# Shared WebSocket

Share **one** WebSocket connection across all browser tabs. Leader election via BroadcastChannel. React 19 hooks and Vue 3 composables included. Zero dependencies.

[![npm](https://img.shields.io/npm/v/@gwakko/shared-websocket)](https://www.npmjs.com/package/@gwakko/shared-websocket)

## Table of Contents

- [How It Works](#how-it-works)
- [Installation](#installation)
- [Quick Start](#quick-start)
  - [Vanilla TypeScript](#vanilla-typescript)
  - [React 19](#react-19)
  - [Vue 3](#vue-3)
- [Features](#features)
- [Processing Pipeline](#processing-pipeline)
- [Options](#options)
- [Documentation](#documentation)
- [Browser Support](#browser-support)

## How It Works

```
Tab 1 (Leader)        Tab 2 (Follower)      Tab 3 (Follower)
┌──────────┐          ┌──────────┐          ┌──────────┐
│ WebSocket│          │          │          │          │
│    ↕     │          │          │          │          │
│  Server  │          │          │          │          │
└────┬─────┘          └─────┬────┘          └─────┬────┘
     └────── BroadcastChannel ──────────────────────┘
```

One tab becomes the **leader** (holds the WebSocket). Others are **followers** (receive data via BroadcastChannel). Leader closes → automatic election → new leader connects. Zero downtime.

## Installation

```bash
npm install @gwakko/shared-websocket     # npm
npm install github:Gwakko/shared-websocket  # from GitHub
```

## Quick Start

### Vanilla TypeScript

```typescript
import { withSocket } from '@gwakko/shared-websocket';

await withSocket('wss://api.example.com/ws', {
  auth: () => localStorage.getItem('token')!,
  useWorker: true,  // optional: offload to Web Worker
}, async ({ ws, signal }) => {

  // Listen to events (works in ALL tabs)
  ws.on('chat.message', (msg) => renderMessage(msg));

  // Send (auto-routed through leader)
  ws.send('chat.message', { text: 'Hello!' });

  // Stream
  for await (const tick of ws.stream('trading.tick', signal)) {
    updateChart(tick);
  }

  // Sync state across tabs (no server)
  ws.sync('cart', { items: [1, 2, 3] });
  ws.onSync('cart', (cart) => updateBadge(cart.items.length));

  // Private channel
  const chat = ws.channel('chat:room_42');
  chat.on('message', (msg) => render(msg));
  chat.send('message', { text: 'Hi room!' });

  // Push notifications
  ws.push('notification', {
    render: (n) => toast(n.title),          // sonner/react-hot-toast
    title: (n) => n.title,                  // + browser Notification
    target: 'active',                       // active | leader | all
  });

  // Runtime auth — authenticate/deauthenticate without reconnecting
  ws.authenticate(token);                   // → sends $auth:login to server
  const chat = ws.channel('chat:private', { auth: true }); // auto-leaves on deauth
  ws.deauthenticate();                      // → auto-leaves auth channels/topics
});
```

### React 19

```tsx
import {
  SharedWebSocketProvider,
  useSharedWebSocket,
  useSocketAuth,
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

function App() {
  return (
    <SharedWebSocketProvider
      url="wss://api.example.com/ws"
      options={{ auth: () => getToken(), useWorker: true }}
    >
      <Dashboard />
    </SharedWebSocketProvider>
  );
}

function Dashboard() {
  const ws = useSharedWebSocket();
  const { isAuthenticated, authenticate, deauthenticate } = useSocketAuth();
  const order = useSocketEvent<Order>('order.created');
  const [cart, setCart] = useSocketSync('cart', { items: [] });
  const { connected, tabRole } = useSocketStatus();

  // Callback variant
  useSocketEvent<Order>('order.created', (order) => {
    playSound('new-order');
  });

  // Lifecycle
  useSocketLifecycle({
    onConnect: () => toast.success('Connected'),
    onActive: () => refreshData(),
    onAuthChange: (auth) => !auth && navigate('/login'),
  });

  // Auth-aware channel — auto-leaves on deauth
  const chat = useChannel(`chat:${roomId}`, { auth: true });

  // Topics
  useTopics(['notifications:orders']);

  // Push
  usePush('notification', {
    render: (n) => toast(n.title),
    target: 'active',
  });

  return <div>{connected ? 'Online' : 'Offline'} ({tabRole})</div>;
}
```

### Vue 3

```typescript
// main.ts
app.use(createSharedWebSocketPlugin('wss://api.example.com/ws', {
  auth: () => getToken(),
  useWorker: true,
}));
```

```vue
<script setup lang="ts">
import {
  useSharedWebSocket,
  useSocketAuth,
  useSocketEvent,
  useSocketSync,
  useSocketLifecycle,
  useChannel,
  useTopics,
  usePush,
} from '@gwakko/shared-websocket/vue';

const ws = useSharedWebSocket();
const { isAuthenticated, authenticate, deauthenticate } = useSocketAuth();
const order = useSocketEvent<Order>('order.created');
const cart = useSocketSync('cart', { items: [] });

useSocketLifecycle({
  onConnect: () => toast.success('Connected'),
  onActive: () => refreshData(),
  onAuthChange: (auth) => { if (!auth) router.push('/login'); },
});

// Auth-aware channel — auto-leaves on deauth
const chat = useChannel(`chat:${roomId}`, { auth: true });
useTopics(['notifications:orders']);

usePush('notification', {
  render: (n) => toast(n.title),
});
</script>
```

## Features

| Feature | Description |
|---------|-------------|
| **Leader Election** | One tab holds WebSocket, others receive via BroadcastChannel |
| **Auto Failover** | Leader closes → new election → reconnect in ~5s |
| **Typed Events** | `SharedWebSocket<EventMap>` — type-safe on/send/stream |
| **Channels** | `ws.channel('room')` — scoped events, auto join/leave |
| **Topics** | `ws.subscribe('topic')` — server-side filtered subscriptions |
| **Tab Sync** | `ws.sync(key, value)` — state across tabs, no server |
| **Standalone Tab Sync** | `TabSync` — cross-tab state without WebSocket (`/sync` import) |
| **Push Notifications** | `ws.push()` — render (sonner) + browser Notification API |
| **Middleware** | `ws.use('incoming'/'outgoing', fn)` — transform, filter, log |
| **Worker Mode** | `useWorker: true` — WebSocket off main thread |
| **Custom Serialization** | `serialize`/`deserialize` — JSON, MessagePack, Protobuf |
| **Per-Event Serializers** | `ws.serializer(event, fn)` — binary for specific events |
| **Runtime Auth** | `authenticate(token)` / `deauthenticate()` on existing connection |
| **Lifecycle Hooks** | onConnect, onDisconnect, onActive, onInactive, onLeaderChange, onAuthChange |
| **Debug/Logger** | `debug: true` + injectable logger (pino, Sentry) |
| **Event Protocol** | Configurable field names (Socket.IO, Phoenix, Laravel Echo) |
| **Auth** | URL param (`auth` callback / `authToken`) + runtime `authenticate()`/`deauthenticate()` |
| **Zero Dependencies** | Pure browser APIs |

## Processing Pipeline

```
Outgoing: ws.send(event, data)
  → per-event serializer         (if registered)
  → outgoing middleware           (transform/inspect/drop)
  → global serialize              (JSON/msgpack — configurable)
  → WebSocket.send()              (or Worker → WebSocket.send)

Incoming: WebSocket.onmessage
  → global deserialize            (JSON/msgpack — configurable)
  → incoming middleware            (transform/inspect/drop)
  → per-event deserializer        (if registered)
  → emit to handlers              (all tabs via BroadcastChannel)
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `protocols` | `string[]` | `[]` | WebSocket subprotocols |
| `reconnect` | `boolean` | `true` | Auto-reconnect |
| `reconnectMaxDelay` | `number` | `30000` | Max backoff (ms) |
| `heartbeatInterval` | `number` | `30000` | Ping interval (ms) |
| `sendBuffer` | `number` | `100` | Buffered messages during reconnect |
| `auth` | `() => string` | — | Token callback (each connect) |
| `authToken` | `string` | — | Static token |
| `authParam` | `string` | `"token"` | URL query param name |
| `useWorker` | `boolean` | `false` | WebSocket in Web Worker |
| `workerUrl` | `string \| URL` | — | Custom worker file |
| `serialize` | `(data) => string \| ArrayBuffer` | `JSON.stringify` | Global serializer |
| `deserialize` | `(raw) => unknown` | `JSON.parse` | Global deserializer |
| `events` | `Partial<EventProtocol>` | — | Custom event/field names |
| `debug` | `boolean` | `false` | Enable logging |
| `logger` | `Logger` | `console` | Custom logger |

## Documentation

| Document | Contents |
|----------|----------|
| **[Getting Started](docs/getting-started.md)** | Installation, basic usage, withSocket |
| **[API Reference](docs/api-reference.md)** | Methods, options, React hooks, Vue composables |
| **[Features](docs/features.md)** | Typed events, channels, topics, push, sync, lifecycle, Zod |
| **[Configuration](docs/configuration.md)** | Serialization, middleware, event protocol, debug, Worker |
| **[Tab Sync](docs/tab-sync.md)** | Standalone cross-tab state — no WebSocket needed |
| **[Server Guide](docs/server-guide.md)** | Node.js, Go, PHP examples + system events |
| **[Types](docs/types.md)** | All exported types with import examples |

## Browser Support

| API | Chrome | Firefox | Safari | Edge |
|-----|--------|---------|--------|------|
| BroadcastChannel | 54+ | 38+ | 15.4+ | 79+ |
| Web Worker | ✅ | ✅ | ✅ | ✅ |
| AsyncGenerator | 63+ | 57+ | 12+ | 79+ |

## License

MIT
