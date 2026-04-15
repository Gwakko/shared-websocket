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
  auth: () => localStorage.getItem('token')!,  // or authToken: 'static-token'
  authParam: 'token',  // default — query param name (?token=xxx)
  useWorker: true,     // optional — offload WebSocket to Web Worker
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
app.use(createSharedWebSocketPlugin('wss://api.example.com/ws', {
  auth: () => localStorage.getItem('token')!,
  useWorker: true,
}));
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
| `auth` | `() => string` | — | Token provider callback (called on each connect) |
| `authToken` | `string` | — | Static token (alternative to `auth` callback) |
| `authParam` | `string` | `"token"` | Query parameter name for token |
| **`useWorker`** | **`boolean`** | **`false`** | **Run WebSocket in Web Worker** |
| `workerUrl` | `string \| URL` | — | Custom worker URL (if useWorker) |
| `electionTimeout` | `number` | `200` | Leader election timeout (ms) |
| `leaderHeartbeat` | `number` | `2000` | Leader heartbeat interval (ms) |
| `leaderTimeout` | `number` | `5000` | Leader absence timeout (ms) |

### Authentication

Three ways to pass a token. Token is appended as a query parameter (default `?token=xxx`):

```typescript
// 1. Callback — fresh token on every connect/reconnect
{ auth: () => localStorage.getItem('token')! }
// → wss://api.example.com/ws?token=eyJhb...

// 2. Static token — simple, no callback
{ authToken: 'eyJhbGciOiJIUzI1NiIs...' }
// → wss://api.example.com/ws?token=eyJhb...

// 3. Custom parameter name
{ auth: () => getToken(), authParam: 'access_token' }
// → wss://api.example.com/ws?access_token=eyJhb...

// 4. No auth
{}  // connects without token
```

Priority: `auth` callback > `authToken` static > no token.
Default parameter name: `"token"`. Override with `authParam`.

URL with existing query parameters is safe — token is appended without breaking anything (uses `URL` + `searchParams.set()`):
```typescript
// URL already has params — works fine
new SharedWebSocket('wss://api.example.com/ws?room=general&lang=en', {
  auth: () => getToken(),
})
// → wss://api.example.com/ws?room=general&lang=en&token=eyJhb...
```

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
| `useSocketLifecycle(handlers)` | — | onConnect, onDisconnect, onReconnecting, onLeaderChange, onError |
| `useChannel(name)` | `Channel` handle | Auto-join/leave on mount/unmount |

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

## Custom Event Protocol

Override event/field names when your server uses different conventions.

```typescript
// Default: { event: 'chat.message', data: { text: 'hi' } }
new SharedWebSocket(url);

// Socket.IO style: { type: 'chat.message', payload: { text: 'hi' } }
new SharedWebSocket(url, {
  events: {
    eventField: 'type',       // message field for event name
    dataField: 'payload',     // message field for payload
  },
});

// Phoenix/Elixir style: join/leave events + custom ping
new SharedWebSocket(url, {
  events: {
    channelJoin: 'phx_join',
    channelLeave: 'phx_leave',
    ping: { event: 'heartbeat', payload: {} },
  },
});

// Laravel Echo / Pusher style
new SharedWebSocket(url, {
  events: {
    eventField: 'event',
    dataField: 'data',
    channelJoin: 'pusher:subscribe',
    channelLeave: 'pusher:unsubscribe',
    ping: { event: 'pusher:ping', data: {} },
  },
});

// Action Cable (Rails) style
new SharedWebSocket(url, {
  events: {
    eventField: 'type',
    dataField: 'message',
    channelJoin: 'subscribe',
    channelLeave: 'unsubscribe',
    ping: { type: 'ping' },
    defaultEvent: 'message',
  },
});
```

All fields in `events` are optional — override only what differs from defaults.

| Field | Default | Description |
|-------|---------|-------------|
| `eventField` | `"event"` | Message field name for event type |
| `dataField` | `"data"` | Message field name for payload |
| `channelJoin` | `"$channel:join"` | Event sent when joining a channel |
| `channelLeave` | `"$channel:leave"` | Event sent when leaving a channel |
| `ping` | `{ type: "ping" }` | Heartbeat payload |
| `defaultEvent` | `"message"` | Fallback event when message has no event field |

## Advanced Examples

### Stream — consume events as async iterator

```typescript
// Vanilla
await withSocket(url, async ({ ws, signal }) => {
  for await (const tick of ws.stream('trading.tick', signal)) {
    updateChart(tick);  // yields one event at a time
  }
  // auto-cleanup: unsubscribes when signal aborts or loop breaks
});
```

```tsx
// React — stream into state with limit
const [logs, setLogs] = useState<LogEntry[]>([]);
useSocketStream<LogEntry>('server.log', (entry) => {
  setLogs(prev => [...prev, entry].slice(-500));
});
```

```vue
<!-- Vue — stream into ref -->
<script setup>
const logs = ref<LogEntry[]>([]);
useSocketStream<LogEntry>('server.log', (entry) => {
  logs.value = [...logs.value, entry].slice(-500);
});
</script>
```

### Request — request/response through server

```typescript
// Vanilla — request user profile via server
await withSocket(url, async ({ ws }) => {
  const user = await ws.request<User>('user.profile', { id: 123 }, 5000);
  console.log(user.name);  // response from server, 5s timeout
});
```

```tsx
// React
function UserProfile({ userId }: { userId: string }) {
  const ws = useSharedWebSocket();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    ws.request<User>('user.profile', { id: userId }).then(setUser);
  }, [userId]);

  return user ? <div>{user.name}</div> : <div>Loading...</div>;
}
```

### Protocols — WebSocket subprotocols

```typescript
// Pass subprotocols for server-side protocol negotiation
new SharedWebSocket('wss://api.example.com/ws', {
  protocols: ['graphql-ws', 'graphql-transport-ws'],
});

// Common protocols:
// 'graphql-ws' — GraphQL over WebSocket
// 'mqtt' — MQTT over WebSocket
// 'wamp.2.json' — WAMP v2
```

### Worker URL — custom worker file

```typescript
// Default: inline blob worker (no extra files needed)
new SharedWebSocket(url, { useWorker: true });

// Custom worker file (for CSP restrictions or custom logic):
new SharedWebSocket(url, {
  useWorker: true,
  workerUrl: '/workers/socket.worker.js',  // your own worker file
});

// Or as URL object:
new SharedWebSocket(url, {
  useWorker: true,
  workerUrl: new URL('./socket.worker.ts', import.meta.url),  // Vite handles this
});
```

### Lifecycle Hooks

```typescript
// Vanilla
await withSocket(url, async ({ ws }) => {
  ws.onConnect(() => console.log('Connected!'));
  ws.onDisconnect(() => showOfflineBanner());
  ws.onReconnecting(() => showSpinner());
  ws.onLeaderChange((isLeader) => console.log('Leader:', isLeader));
  ws.onError((err) => reportToSentry(err));
});
```

```tsx
// React
useSocketLifecycle({
  onConnect: () => toast.success('Connected'),
  onDisconnect: () => toast.error('Connection lost'),
  onReconnecting: () => toast.loading('Reconnecting...'),
  onLeaderChange: (isLeader) => {
    if (isLeader) console.log('This tab is now the leader');
  },
  onError: (err) => Sentry.captureException(err),
});
```

```vue
<!-- Vue -->
<script setup>
useSocketLifecycle({
  onConnect: () => toast.success('Connected'),
  onDisconnect: () => toast.error('Connection lost'),
  onReconnecting: () => toast.loading('Reconnecting...'),
  onError: (err) => reportError(err),
});
</script>
```

### Private Channels — chat rooms, tenant notifications

The `channel()` method creates a scoped handle. Events are prefixed with the channel name. Server receives `$channel:join` / `$channel:leave` events.

```typescript
// Vanilla — private chat room
await withSocket(url, { auth: () => getToken() }, async ({ ws }) => {
  const chat = ws.channel('chat:room_42');

  chat.on('message', (msg) => renderMessage(msg));
  chat.on('typing', (user) => showTyping(user));
  chat.send('message', { text: 'Hello room!' });

  // When done:
  chat.leave();  // sends $channel:leave to server, unsubscribes all
});

// Tenant-scoped notifications
await withSocket(url, { auth: () => getToken() }, async ({ ws }) => {
  const notifs = ws.channel(`tenant:${tenantId}:notifications`);
  notifs.on('alert', (alert) => showToast(alert));
  notifs.on('update', (update) => refreshDashboard(update));

  // User's private channel
  const user = ws.channel(`user:${userId}`);
  user.on('message', (dm) => showDirectMessage(dm));
  user.on('mention', (mention) => highlightMention(mention));
});
```

```tsx
// React — auto join/leave on mount/unmount
function ChatRoom({ roomId }: { roomId: string }) {
  const chat = useChannel(`chat:${roomId}`);

  // Events are prefixed: 'chat:room_42:message'
  const message = useSocketEvent<Message>(`chat:${roomId}:message`);
  const typing = useSocketEvent<User>(`chat:${roomId}:typing`);

  function send(text: string) {
    chat.send('message', { text });
  }

  return (/* ... */);
}
// When ChatRoom unmounts → chat.leave() called automatically

// Tenant notifications
function TenantAlerts({ tenantId }: { tenantId: string }) {
  const channel = useChannel(`tenant:${tenantId}:notifications`);

  useSocketCallback(`tenant:${tenantId}:notifications:alert`, (alert) => {
    showToast(alert);
  });

  return null;
}
```

```vue
<!-- Vue — private channel -->
<script setup>
const props = defineProps<{ roomId: string }>();

const chat = useChannel(`chat:${props.roomId}`);
const message = useSocketEvent<Message>(`chat:${props.roomId}:message`);

function send(text: string) {
  chat.send('message', { text });
}
// Auto-leave on unmount
</script>
```

### Server-side channel handling

```typescript
// Node.js — handle channel join/leave
wss.on('connection', (ws) => {
  const channels = new Set<string>();

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.event === '$channel:join') {
      channels.add(msg.data.channel);
      console.log(`Client joined ${msg.data.channel}`);
      return;
    }

    if (msg.event === '$channel:leave') {
      channels.delete(msg.data.channel);
      return;
    }

    // Route channel messages
    // msg.event = 'chat:room_42:message'
    // Extract channel: 'chat:room_42'
  });
});
```

## Exported Types

All types are available for import in your projects:

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

```tsx
// React — all hooks + types
import {
  SharedWebSocketProvider,
  useSharedWebSocket,
  useSocketEvent,
  useSocketStream,
  useSocketSync,
  useSocketCallback,
  useSocketStatus,
  useSocketLifecycle,
  useChannel,
} from '@gwakko/shared-websocket/react';

import type { SharedWebSocketProviderProps } from '@gwakko/shared-websocket/react';
```

```typescript
// Vue — all composables + types
import {
  createSharedWebSocketPlugin,
  useSharedWebSocket,
  useSocketEvent,
  useSocketStream,
  useSocketSync,
  useSocketCallback,
  useSocketStatus,
  useSocketLifecycle,
  useChannel,
  SharedWebSocketKey,       // InjectionKey for custom provide/inject
} from '@gwakko/shared-websocket/vue';
```

### Usage with custom types

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

## Browser Support

| API | Chrome | Firefox | Safari | Edge |
|-----|--------|---------|--------|------|
| BroadcastChannel | 54+ | 38+ | 15.4+ | 79+ |
| Web Worker | ✅ | ✅ | ✅ | ✅ |
| AsyncGenerator | 63+ | 57+ | 12+ | 79+ |

## License

MIT
