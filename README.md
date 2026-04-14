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

### From npm

```bash
npm install @gwakko/shared-websocket
```

### From GitHub (latest source)

```bash
npm install github:Gwakko/shared-websocket
```

### Manual (copy into your project)

```bash
# Clone and copy src/ into your project
git clone https://github.com/Gwakko/shared-websocket.git
cp -r shared-websocket/src ./your-project/shared-websocket
```

### Build from source

```bash
git clone https://github.com/Gwakko/shared-websocket.git
cd shared-websocket
npm install
npm run build   # outputs ESM + CJS + types to dist/
```

## Usage — Vanilla TypeScript

```typescript
import { SharedWebSocket } from '@gwakko/shared-websocket';

const ws = new SharedWebSocket('wss://api.example.com/ws', {
  auth: () => localStorage.getItem('token')!,
  useWorker: true,  // optional: run WebSocket in Web Worker (offloads main thread)
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
ws.disconnect();
```

### Scoped Lifecycle — `withSocket()`

Auto-creates, connects, and disposes. Guarantees cleanup even on errors.

```typescript
import { withSocket } from '@gwakko/shared-websocket';

// Basic
await withSocket('wss://api.example.com/ws', async ({ ws }) => {
  ws.on('order.created', (order) => console.log(order));
  await longRunningWork();
}); // auto-disposed here

// With auth
await withSocket('wss://api.example.com/ws', {
  auth: () => localStorage.getItem('token')!,
}, async ({ ws, signal }) => {
  for await (const msg of ws.stream('chat.messages', signal)) {
    renderMessage(msg);
  }
});

// Tab-to-tab sync via BroadcastChannel (no server roundtrip)
await withSocket('wss://api.example.com/ws', async ({ ws }) => {
  // Send state to ALL tabs instantly
  ws.sync('cart', { items: [1, 2, 3] });
  ws.sync('theme', 'dark');
  ws.sync('locale', 'en');

  // Read synced state from other tabs
  const cart = ws.getSync<Cart>('cart');  // { items: [1, 2, 3] }

  // React to changes from other tabs
  ws.onSync('cart', (cart) => {
    updateCartBadge(cart.items.length);
  });

  ws.onSync('theme', (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
  });
});

// Combine: server events + tab sync
await withSocket('wss://api.example.com/ws', {
  auth: () => localStorage.getItem('token')!,
}, async ({ ws, signal }) => {
  // Server events → update state → sync to all tabs
  ws.on('order.status', (order) => {
    ws.sync('activeOrder', order);  // all tabs see the update
  });

  // One tab adds to cart → all tabs update
  ws.onSync('cart', (cart) => renderCart(cart));

  // Stream server messages with auto-cleanup
  for await (const msg of ws.stream('chat.messages', signal)) {
    renderMessage(msg);
  }
});

// With external cancellation (AbortController)
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);

await withSocket('wss://api.example.com/ws', {
  signal: controller.signal,
}, async ({ ws, signal }) => {
  ws.on('notifications', showToast);
  await new Promise((_, reject) => signal.addEventListener('abort', reject));
});
```

## Usage — React

```tsx
import {
  SharedWebSocketProvider,
  useSharedWebSocket,
  useSocketEvent,
  useSocketStream,
  useSocketSync,
  useSocketStatus,
} from '@gwakko/shared-websocket/react';

// Provider accepts url and options as props
function App() {
  return (
    <SharedWebSocketProvider
      url="wss://api.example.com/ws"
      options={{
        auth: () => localStorage.getItem('token')!,
        useWorker: true,
      }}
    >
      <Dashboard />
    </SharedWebSocketProvider>
  );
}

function Dashboard() {
  const ws = useSharedWebSocket();

  // Latest event value (reactive) — no need to pass ws, uses context
  const order = useSocketEvent<Order>('order.created');

  // Accumulated stream
  const messages = useSocketStream<Message>('chat.message');

  // Synced across tabs (no server roundtrip)
  const [cart, setCart] = useSocketSync('cart', { items: [] });

  // Connection status
  const { connected, tabRole } = useSocketStatus();

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
import { createSharedWebSocketPlugin } from '@gwakko/shared-websocket/vue';
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
} from '@gwakko/shared-websocket/vue';

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
| `[Symbol.dispose]()` | Cleanup (also called by `disconnect`) |

### withSocket()

| Signature | Description |
|-----------|-------------|
| `withSocket(url, callback)` | Scoped lifecycle, auto-dispose |
| `withSocket(url, options, callback)` | With auth, signal, etc. |

Callback receives `{ ws, signal }` — destructure what you need. Signal aborts when scope exits.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `protocols` | `string[]` | `[]` | WebSocket subprotocols |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect |
| `reconnectMaxDelay` | `number` | `30000` | Max reconnect backoff (ms) |
| `heartbeatInterval` | `number` | `30000` | Ping interval (ms) |
| `sendBuffer` | `number` | `100` | Max buffered messages during reconnect |
| `auth` | `() => string` | — | JWT token provider |
| **`useWorker`** | **`boolean`** | **`false`** | **Run WebSocket in Web Worker** |
| `workerUrl` | `string \| URL` | — | Custom worker URL (if useWorker) |
| `electionTimeout` | `number` | `200` | Leader election timeout (ms) |
| `leaderHeartbeat` | `number` | `2000` | Leader heartbeat interval (ms) |
| `leaderTimeout` | `number` | `5000` | Leader absence timeout (ms) |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Connection status |
| `tabRole` | `'leader' \| 'follower'` | Current tab's role |

### React Hooks (React 19, `useEffectEvent` for stable refs)

All hooks use context internally — no need to pass `ws`. Every hook accepts an **optional callback** for custom handling.

| Hook | Without callback | With callback |
|------|-----------------|---------------|
| `useSharedWebSocket()` | `SharedWebSocket` | — |
| `useSocketEvent<T>(event, cb?)` | Returns `T \| undefined` | `cb(data)` on each event |
| `useSocketStream<T>(event, cb?)` | Returns `T[]` (accumulated) | `cb(data)` — manage your own state |
| `useSocketSync<T>(key, init, cb?)` | Returns `[T, setter]` | `cb(value)` — side effects on sync |
| `useSocketCallback<T>(event, cb)` | — | Fire-and-forget (no state) |
| `useSocketStatus()` | `{ connected, tabRole }` | — |

```tsx
// Without callback — reactive state
const order = useSocketEvent<Order>('order.created');

// With callback — custom logic, stable ref
useSocketEvent<Order>('order.created', (order) => {
  playSound('new-order');
  analytics.track('order_received', order);
});

// Stream with limit
const [msgs, setMsgs] = useState<Message[]>([]);
useSocketStream<Message>('chat.message', (msg) => {
  setMsgs(prev => [msg, ...prev].slice(0, 50));
});

// Sync with side effect
const [cart, setCart] = useSocketSync('cart', { items: [] }, (cart) => {
  document.title = `Cart (${cart.items.length})`;
});

// Fire-and-forget
useSocketCallback<Notification>('notification', (n) => {
  if (ws.tabRole === 'leader') new Notification(n.title);
});
```

### Vue Composables

All composables accept an **optional callback** — same pattern as React hooks.

| Composable | Without callback | With callback |
|-----------|-----------------|---------------|
| `useSharedWebSocket()` | `SharedWebSocket` | — |
| `useSocketEvent<T>(event, cb?)` | `Ref<T>` | `cb(data)` on each event |
| `useSocketStream<T>(event, cb?)` | `Ref<T[]>` | `cb(data)` — manage your own ref |
| `useSocketSync<T>(key, init, cb?)` | `Ref<T>` (two-way) | `cb(value)` — side effects on sync |
| `useSocketCallback<T>(event, cb)` | — | Fire-and-forget |
| `useSocketStatus()` | `{ connected, tabRole }` | — |

## How It Works

1. **Leader Election** — new tab broadcasts election request via BroadcastChannel. If no rejection in 200ms → becomes leader. Leader sends heartbeat every 2s. No heartbeat for 5s → new election.

2. **Message Flow** — follower calls `send()` → message goes to BroadcastChannel → leader picks it up → forwards to WebSocket → server response → leader broadcasts to all tabs.

3. **Failover** — leader tab closes → `beforeunload` fires `abdicate` → followers detect missing heartbeat → election → new leader connects WebSocket → zero data loss (buffered messages replayed).

4. **Resource Safety** — `withSocket()` for scoped lifecycle, `Symbol.dispose` support. All timers, listeners, and channels properly cleaned up.

5. **Worker Mode** (optional) — `useWorker: true` runs WebSocket inside a Web Worker. JSON parsing, heartbeat timers, and reconnection logic run off main thread. UI stays responsive even at high message rates.

## When to Use `useWorker: true`

| Scenario | useWorker | Why |
|----------|-----------|-----|
| Chat (10-50 msgs/sec) | `false` | Low overhead, not worth Worker complexity |
| Simple notifications | `false` | Few messages, main thread handles fine |
| Live trading feed (100+ msgs/sec) | **`true`** | JSON parsing 100+ msgs/sec blocks rendering |
| Real-time dashboard (50+ metrics/sec) | **`true`** | Continuous data stream, UI must stay smooth |
| Heavy payload (>100KB per message) | **`true`** | Parsing large JSON blocks main thread |
| Complex UI (React with 10k+ rows) | **`true`** | Main thread already busy, any extra work causes jank |
| Mobile / low-end devices | **`true`** | Less CPU available, offloading helps |
| Simple landing page | `false` | Minimal UI, no rendering pressure |
| SSR / Node.js | `false` | Workers are browser-only |
| Debugging | `false` | Worker DevTools is less convenient |

**Rule of thumb:** If your app drops frames when WebSocket messages arrive — add `useWorker: true`.

```typescript
// Without worker (default) — WebSocket in main thread
const ws = new SharedWebSocket(url);

// With worker — WebSocket in Web Worker
const ws = new SharedWebSocket(url, { useWorker: true });

// API is identical — only internal transport changes
```

## Browser Support

| API | Chrome | Firefox | Safari | Edge |
|-----|--------|---------|--------|------|
| BroadcastChannel | 54+ | 38+ | 15.4+ | 79+ |
| Web Worker | ✅ | ✅ | ✅ | ✅ |
| AsyncGenerator | 63+ | 57+ | 12+ | 79+ |

## License

MIT
