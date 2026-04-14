# Shared WebSocket

Share ONE WebSocket connection across multiple browser tabs. Zero dependencies. React and Vue adapters included.

## Problem

5 tabs open = 5 WebSocket connections = 5x server resources for the same user.

## Solution

One tab becomes the **leader** (holds the WebSocket). Other tabs are **followers** (receive data via BroadcastChannel). If the leader closes — automatic election picks a new leader. Zero downtime.

```
Tab 1 (Leader)        Tab 2 (Follower)      Tab 3 (Follower)
┌──────────┐          ┌──────────┐          ┌──────────┐
│ WebSocket│          │          │          │          │
│    ↕     │          │          │          │          │
│  Server  │          │          │          │          │
└────┬─────┘          └─────┬────┘          └─────┬────┘
     └────── BroadcastChannel ──────────────────────┘
```

## Installation

```bash
npm install shared-websocket
```

## Usage — Vanilla TypeScript

```typescript
import { SharedWebSocket } from 'shared-websocket';

const ws = new SharedWebSocket('wss://api.example.com/ws', {
  auth: () => localStorage.getItem('token')!,
});

await ws.connect();

// Subscribe to events (works in ALL tabs)
ws.on('order.created', (order) => {
  console.log('New order:', order);
});

// Send message (auto-routed through leader tab)
ws.send('chat.message', { text: 'Hello!' });

// Generator streaming
for await (const msg of ws.stream('chat.messages')) {
  console.log(msg);
}

// Sync state across tabs (no server roundtrip)
ws.sync('cart', { items: [1, 2, 3] });
ws.onSync('cart', (cart) => console.log('Cart updated:', cart));

// Cleanup
ws[Symbol.dispose]();
// or with `using`:
// using ws = new SharedWebSocket(url);
```

## Usage — React

```tsx
import { createSharedWebSocket, useSocketEvent, useSocketSync, useSocketStatus } from 'shared-websocket/adapters/react';

// Create instance + Provider
const { Provider, useSocket } = createSharedWebSocket('wss://api.example.com/ws', {
  auth: () => localStorage.getItem('token')!,
});

function App() {
  return (
    <Provider>
      <Dashboard />
    </Provider>
  );
}

function Dashboard() {
  const ws = useSocket();

  // Latest event value (reactive)
  const order = useSocketEvent<Order>(ws, 'order.created');

  // Accumulated stream
  const messages = useSocketStream<Message>(ws, 'chat.message');

  // Synced across tabs
  const [cart, setCart] = useSocketSync(ws, 'cart', { items: [] });

  // Connection status
  const { connected, tabRole } = useSocketStatus(ws);

  return (
    <div>
      <p>Status: {connected ? 'Online' : 'Offline'} ({tabRole})</p>
      {order && <p>Latest order: #{order.id}</p>}
      <button onClick={() => ws.send('ping', {})}>Ping</button>
      <button onClick={() => setCart({ items: [...cart.items, Date.now()] })}>
        Add to cart ({cart.items.length})
      </button>
    </div>
  );
}
```

## Usage — Vue 3

```vue
<!-- main.ts -->
<script setup>
import { createApp } from 'vue';
import { createSharedWebSocketPlugin } from 'shared-websocket/adapters/vue';
import App from './App.vue';

const app = createApp(App);
app.use(createSharedWebSocketPlugin('wss://api.example.com/ws'));
app.mount('#app');
</script>
```

```vue
<!-- Dashboard.vue -->
<script setup lang="ts">
import {
  useSharedWebSocket,
  useSocketEvent,
  useSocketStream,
  useSocketSync,
  useSocketStatus,
} from 'shared-websocket/adapters/vue';

const ws = useSharedWebSocket();

const order = useSocketEvent<Order>('order.created');
const messages = useSocketStream<Message>('chat.message');
const cart = useSocketSync('cart', { items: [] });
const { connected, tabRole } = useSocketStatus();

function addToCart() {
  cart.value = { items: [...cart.value.items, Date.now()] };
}
</script>

<template>
  <p>Status: {{ connected ? 'Online' : 'Offline' }} ({{ tabRole }})</p>
  <p v-if="order">Latest order: #{{ order.id }}</p>
  <button @click="ws.send('ping', {})">Ping</button>
  <button @click="addToCart">Add to cart ({{ cart.items.length }})</button>
</template>
```

## API Reference

### SharedWebSocket

| Method | Description |
|--------|-------------|
| `connect()` | Start leader election and connect |
| `on(event, handler)` | Subscribe to server events (all tabs) |
| `once(event, handler)` | Subscribe once |
| `off(event, handler?)` | Unsubscribe |
| `stream(event, signal?)` | AsyncGenerator for consuming events |
| `send(event, data)` | Send to server (routed through leader) |
| `request(event, data, timeout?)` | Request/response via server |
| `sync(key, value)` | Sync state across tabs |
| `getSync(key)` | Get synced value |
| `onSync(key, fn)` | Listen for sync changes |
| `disconnect()` | Close connection and cleanup |
| `[Symbol.dispose]()` | Automatic cleanup with `using` |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Connection status |
| `tabRole` | `'leader' \| 'follower'` | Current tab's role |

### React Hooks

| Hook | Returns | Description |
|------|---------|-------------|
| `useSocketEvent<T>(ws, event)` | `T \| undefined` | Latest event value |
| `useSocketStream<T>(ws, event)` | `T[]` | Accumulated events |
| `useSocketSync<T>(ws, key, init)` | `[T, setter]` | Cross-tab synced state |
| `useSocketStatus(ws)` | `{ connected, tabRole }` | Connection status |

### Vue Composables

| Composable | Returns | Description |
|-----------|---------|-------------|
| `useSocketEvent<T>(event)` | `Ref<T>` | Latest event value |
| `useSocketStream<T>(event)` | `Ref<T[]>` | Accumulated events |
| `useSocketSync<T>(key, init)` | `Ref<T>` | Cross-tab synced state (two-way) |
| `useSocketStatus()` | `{ connected, tabRole }` | Reactive connection status |

## How It Works

1. **Leader Election** — new tab broadcasts election request via BroadcastChannel. If no rejection in 200ms → becomes leader. Leader sends heartbeat every 2s. No heartbeat for 5s → new election.

2. **Message Flow** — follower calls `send()` → message goes to BroadcastChannel → leader picks it up → forwards to WebSocket → server response → leader broadcasts to all tabs.

3. **Failover** — leader tab closes → `beforeunload` fires `abdicate` → followers detect missing heartbeat → election → new leader connects WebSocket → zero data loss (buffered messages replayed).

4. **Resource Safety** — `Symbol.dispose` support for automatic cleanup. All timers, listeners, and channels properly cleaned up.

## Browser Support

| API | Chrome | Firefox | Safari | Edge |
|-----|--------|---------|--------|------|
| BroadcastChannel | 54+ | 38+ | 15.4+ | 79+ |
| Web Worker | ✅ | ✅ | ✅ | ✅ |
| AsyncGenerator | 63+ | 57+ | 12+ | 79+ |

## License

MIT
