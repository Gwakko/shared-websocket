# Shared WebSocket

Share ONE WebSocket connection across multiple browser tabs. Zero dependencies. React and Vue adapters included.

## Table of Contents

- [Problem](#problem)
- [Solution](#solution)
- [Installation](#installation)
- [Usage — Vanilla TypeScript](#usage--vanilla-typescript)
  - [Scoped Lifecycle — withSocket()](#scoped-lifecycle--withsocket)
- [Usage — React](#usage--react)
- [Usage — Vue 3](#usage--vue-3)
- [API Reference](#api-reference)
  - [Options](#options)
  - [Authentication](#authentication)
  - [React Hooks](#react-hooks-react-19-useeffectevent-for-stable-refs)
  - [Vue Composables](#vue-composables)
- [How It Works](#how-it-works)
- [When to Use `useWorker: true`](#when-to-use-useworker-true)
- [Typed Events](#typed-events)
  - [Type narrowing](#type-narrowing-for-untyped-events)
  - [Runtime validation with Zod](#runtime-validation-with-zod)
- [Middleware](#middleware)
- [Debug Mode & Custom Logger](#debug-mode--custom-logger)
- [Custom Serialization](#custom-serialization)
- [Custom Event Protocol](#custom-event-protocol)
- [Advanced Examples](#advanced-examples)
  - [Stream](#stream--consume-events-as-async-iterator)
  - [Request](#request--requestresponse-through-server)
  - [Protocols](#protocols--websocket-subprotocols)
  - [Worker URL](#worker-url--custom-worker-file)
  - [Lifecycle Hooks](#lifecycle-hooks)
  - [Private Channels](#private-channels--chat-rooms-tenant-notifications)
  - [Server-side channel handling](#server-side-channel-handling)
- [Topics](#topics--server-side-filtered-subscriptions)
- [Push Notifications](#push-notifications)
- [Server-Side Implementation Guide](#server-side-implementation-guide)
- [Exported Types](#exported-types)
- [Browser Support](#browser-support)
- [License](#license)

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
| `serialize` | `(data) => string \| ArrayBuffer` | `JSON.stringify` | Custom outgoing serializer |
| `deserialize` | `(raw) => unknown` | `JSON.parse` | Custom incoming deserializer |

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
| `isActive` | `boolean` | Whether this tab is visible/focused |

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

## Typed Events

Define your event map for full type safety across on/send/stream:

```typescript
type Events = {
  'chat.message': { text: string; userId: string; timestamp: number };
  'chat.typing': { userId: string };
  'order.created': { id: string; total: number; items: string[] };
  'notification': { title: string; body: string; type: 'info' | 'error' };
};

const ws = new SharedWebSocket<Events>('wss://api.example.com/ws');

// ✅ Type-safe — msg is { text, userId, timestamp }
ws.on('chat.message', (msg) => {
  console.log(msg.text);     // string
  console.log(msg.userId);   // string
});

// ✅ Type-safe send
ws.send('chat.message', { text: 'hi', userId: '1', timestamp: Date.now() });

// ❌ TypeScript error — wrong payload type
ws.send('chat.message', { wrong: 'field' });

// ✅ Type-safe stream
for await (const order of ws.stream('order.created')) {
  console.log(order.id);   // string
  console.log(order.total); // number
}

// Still works with untyped events
ws.on('any.custom.event', (data) => { /* data: any */ });
```

```tsx
// React — pass type to hooks
const msg = useSocketEvent<Events['chat.message']>('chat.message');
// msg: { text, userId, timestamp } | undefined
```

### Type narrowing for untyped events

When working without EventMap, data is `unknown`. Use narrowing:

```typescript
// Type guard
function isChatMessage(data: unknown): data is { text: string; userId: string } {
  return typeof data === 'object' && data !== null && 'text' in data && 'userId' in data;
}

// Vanilla
ws.on('chat.message', (data) => {
  if (isChatMessage(data)) {
    console.log(data.text);  // ← now typed as string
  }
});
```

```tsx
// React
useSocketEvent('chat.message', (data) => {
  if (isChatMessage(data)) renderMessage(data);
});
```

```vue
<!-- Vue -->
<script setup>
useSocketEvent('chat.message', (data) => {
  if (isChatMessage(data)) renderMessage(data);
});
</script>
```

### Runtime validation with Zod

```typescript
import { z } from 'zod';

const ChatMessageSchema = z.object({
  text: z.string(),
  userId: z.string(),
  timestamp: z.number(),
});

type ChatMessage = z.infer<typeof ChatMessageSchema>;

// Validate on receive — drop invalid messages via middleware
ws.use('incoming', (raw) => {
  const msg = raw as Record<string, unknown>;
  const data = msg?.data;
  const result = ChatMessageSchema.safeParse(data);
  if (!result.success) {
    console.warn('Invalid message:', result.error.issues);
    return null;  // drop
  }
  return raw;  // pass through
});

// Or validate in handler
ws.on('chat.message', (data) => {
  const result = ChatMessageSchema.safeParse(data);
  if (!result.success) return;

  const msg: ChatMessage = result.data;
  console.log(msg.text);  // fully typed and validated
});

// Zod middleware factory (reusable)
function zodValidate<T>(schema: z.ZodType<T>): Middleware {
  return (raw) => {
    const msg = raw as Record<string, unknown>;
    const result = schema.safeParse(msg?.data ?? msg);
    return result.success ? raw : null;
  };
}

ws.use('incoming', zodValidate(ChatMessageSchema));
ws.use('incoming', zodValidate(OrderSchema));
```

```tsx
// React — Zod validated hook
function useSafeSocketEvent<T>(event: string, schema: z.ZodType<T>): T | undefined {
  const [value, setValue] = useState<T>();

  useSocketEvent(event, (data) => {
    const result = schema.safeParse(data);
    if (result.success) setValue(result.data);
  });

  return value;
}

// Usage
const msg = useSafeSocketEvent('chat.message', ChatMessageSchema);
// msg: ChatMessage | undefined — guaranteed valid
```

```vue
<!-- Vue — Zod validated composable -->
<script setup lang="ts">
import { z } from 'zod';

const ChatMessageSchema = z.object({
  text: z.string(),
  userId: z.string(),
});

// Composable with validation
function useSafeSocketEvent<T>(event: string, schema: z.ZodType<T>) {
  const value = ref<T>();
  useSocketEvent(event, (data) => {
    const result = schema.safeParse(data);
    if (result.success) value.value = result.data as T;
  });
  return readonly(value);
}

const msg = useSafeSocketEvent('chat.message', ChatMessageSchema);
// msg.value: ChatMessage | undefined — guaranteed valid
</script>
```

## Middleware

Transform or inspect messages before send / after receive:

```typescript
const ws = new SharedWebSocket(url);

// Add timestamp to every outgoing message
ws.use('outgoing', (msg) => ({ ...msg, timestamp: Date.now() }));

// Decrypt incoming messages
ws.use('incoming', (msg) => ({ ...msg, data: decrypt(msg.data) }));

// Drop messages from blocked users (return null to drop)
ws.use('incoming', (msg) => blockedUsers.has(msg.userId) ? null : msg);

// Log everything
ws.use('incoming', (msg) => { console.log('← recv', msg); return msg; });
ws.use('outgoing', (msg) => { console.log('→ send', msg); return msg; });

// Chain multiple — executed in order
ws.use('outgoing', addTimestamp)
  .use('outgoing', addRequestId)
  .use('incoming', decryptPayload)
  .use('incoming', validateSchema);
```

```tsx
// React — configure middleware in Provider
function App() {
  const wsRef = useRef<SharedWebSocket>();

  return (
    <SharedWebSocketProvider
      url="wss://api.example.com/ws"
      options={{ debug: true }}
      ref={(provider) => {
        // Access ws instance after mount to add middleware
      }}
    >
      <SetupMiddleware />
      <Dashboard />
    </SharedWebSocketProvider>
  );
}

// Or setup middleware in a component
function SetupMiddleware() {
  const ws = useSharedWebSocket();

  useEffect(() => {
    ws.use('outgoing', (msg) => ({ ...msg, timestamp: Date.now() }));
    ws.use('incoming', zodValidate(MessageSchema));
  }, [ws]);

  return null;
}
```

```vue
<!-- Vue — configure middleware after plugin install -->
<script setup>
// In any component
const ws = useSharedWebSocket();
ws.use('outgoing', (msg) => ({ ...msg, timestamp: Date.now() }));
ws.use('incoming', zodValidate(MessageSchema));
</script>
```

## Debug Mode & Custom Logger

```typescript
// Debug mode — logs all events to console
new SharedWebSocket(url, { debug: true });
// [SharedWS] init { tabId: "abc-123", url: "wss://..." }
// [SharedWS] 👑 became leader
// [SharedWS] ✓ connected
// [SharedWS] → send chat.message { text: "hi" }
// [SharedWS] ← recv chat.message { text: "hello" }
// [SharedWS] 🔄 reconnecting

// Custom logger (pino, winston, bunyan, etc.)
import pino from 'pino';
new SharedWebSocket(url, {
  debug: true,
  logger: pino({ name: 'ws' }),
});

// Sentry integration — errors + breadcrumbs
import * as Sentry from '@sentry/browser';
new SharedWebSocket(url, {
  debug: true,
  logger: {
    debug: (msg, ...args) => Sentry.addBreadcrumb({
      category: 'websocket',
      message: msg,
      data: args[0] as Record<string, unknown>,
      level: 'debug',
    }),
    info: (msg, ...args) => Sentry.addBreadcrumb({
      category: 'websocket',
      message: msg,
      level: 'info',
    }),
    warn: (msg, ...args) => Sentry.addBreadcrumb({
      category: 'websocket',
      message: msg,
      level: 'warning',
    }),
    error: (msg, ...args) => {
      Sentry.captureException(args[0] instanceof Error ? args[0] : new Error(msg));
    },
  },
});

// Logger interface — implement debug/info/warn/error
import type { Logger } from '@gwakko/shared-websocket';
const myLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
```

```tsx
// React — debug + Sentry in Provider
<SharedWebSocketProvider
  url="wss://api.example.com/ws"
  options={{
    debug: process.env.NODE_ENV === 'development',
    logger: sentryLogger,  // your Sentry logger object
  }}
>
  <App />
</SharedWebSocketProvider>
```

```vue
<!-- Vue — debug + Sentry in plugin -->
<script>
// main.ts
app.use(createSharedWebSocketPlugin('wss://api.example.com/ws', {
  debug: import.meta.env.DEV,
  logger: sentryLogger,
}));
</script>
```

## Custom Serialization

By default all messages are serialized/deserialized as JSON. Override for binary formats:

```typescript
// Default — JSON (no config needed)
new SharedWebSocket(url);
// send: JSON.stringify(data) → string
// recv: JSON.parse(raw) → object
```

```typescript
// MessagePack — compact binary format
import { encode, decode } from '@msgpack/msgpack';

new SharedWebSocket(url, {
  serialize: (data) => encode(data),    // returns ArrayBuffer
  deserialize: (raw) => decode(raw),    // accepts ArrayBuffer
});
```

```typescript
// Protobuf
import { MyMessage } from './proto/messages';

new SharedWebSocket(url, {
  serialize: (data) => MyMessage.encode(data as MyMessage).finish(),
  deserialize: (raw) => MyMessage.decode(new Uint8Array(raw as ArrayBuffer)),
});
```

```typescript
// CBOR
import { encode, decode } from 'cbor-x';

new SharedWebSocket(url, {
  serialize: (data) => encode(data),
  deserialize: (raw) => decode(raw as ArrayBuffer),
});
```

```typescript
// Plain text (no serialization)
new SharedWebSocket(url, {
  serialize: (data) => String(data),
  deserialize: (raw) => raw,  // pass through as-is
});
```

```tsx
// React — pass in Provider options
<SharedWebSocketProvider
  url="wss://api.example.com/ws"
  options={{
    serialize: (data) => encode(data),
    deserialize: (raw) => decode(raw),
  }}
>
  <App />
</SharedWebSocketProvider>
```

```vue
<!-- Vue — pass in plugin options -->
<script>
import { encode, decode } from '@msgpack/msgpack';

app.use(createSharedWebSocketPlugin('wss://api.example.com/ws', {
  serialize: (data) => encode(data),
  deserialize: (raw) => decode(raw),
}));
</script>
```

Serialization applies to **all** WebSocket I/O: send, receive, heartbeat, and buffer flush.

| Option | Default | Type | Description |
|--------|---------|------|-------------|
| `serialize` | `JSON.stringify` | `(data) => string \| ArrayBuffer \| Blob` | Outgoing message encoding |
| `deserialize` | `JSON.parse` | `(raw) => unknown` | Incoming message decoding |

> **Note:** `serialize`/`deserialize` options apply to the main-thread `SharedSocket`. For Worker mode, use a custom worker file (see below).

### Custom Worker with Binary Serialization

Functions can't be passed to Workers via `postMessage`. To use custom serialization in Worker mode, copy the template worker and edit the `serialize`/`deserialize` functions:

**1. Copy the template:**
```bash
cp node_modules/@gwakko/shared-websocket/src/worker/socket.worker.template.txt ./src/workers/my-socket.worker.ts
```

**2. Edit `serialize`/`deserialize` at the top:**
```typescript
// my-socket.worker.ts
import { encode, decode } from '@msgpack/msgpack';

function serialize(data: unknown): string | ArrayBuffer {
  return encode(data);  // ← your format
}

function deserialize(raw: string | ArrayBuffer): unknown {
  return decode(raw as ArrayBuffer);  // ← your format
}

// ... rest of worker code unchanged
```

**3. Use your worker:**
```typescript
// Vite
new SharedWebSocket(url, {
  useWorker: true,
  workerUrl: new URL('./workers/my-socket.worker.ts', import.meta.url),
});

// Webpack 5
new SharedWebSocket(url, {
  useWorker: true,
  workerUrl: new URL('./workers/my-socket.worker.ts', import.meta.url),
});

// Static file (pre-built)
new SharedWebSocket(url, {
  useWorker: true,
  workerUrl: '/workers/my-socket.worker.js',
});
```

The template file is at `src/worker/socket.worker.template.txt` — fully commented with MessagePack, Protobuf, and CBOR examples.

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
  // Connection lifecycle
  ws.onConnect(() => console.log('Connected!'));
  ws.onDisconnect(() => showOfflineBanner());
  ws.onReconnecting(() => showSpinner());
  ws.onError((err) => reportToSentry(err));

  // Tab role
  ws.onLeaderChange((isLeader) => console.log('Leader:', isLeader));

  // Tab visibility
  ws.onActive(() => {
    console.log('Tab is now active');
    markNotificationsAsRead();
  });
  ws.onInactive(() => {
    console.log('Tab went to background');
    pauseAnimations();
  });
  ws.onVisibilityChange((isActive) => {
    console.log('Visibility:', isActive ? 'visible' : 'hidden');
  });

  // Check current state
  console.log('Is active:', ws.isActive);
  console.log('Tab role:', ws.tabRole);
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

  // Tab visibility
  onActive: () => {
    markNotificationsAsRead();
    refreshData();
  },
  onInactive: () => {
    pausePolling();
  },
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
  onActive: () => refreshData(),
  onInactive: () => pausePolling(),
});
</script>
```

Available lifecycle hooks:

| Hook | When | Use case |
|------|------|----------|
| `onConnect` | WebSocket connected | Hide offline banner, sync state |
| `onDisconnect` | WebSocket closed | Show offline banner |
| `onReconnecting` | Reconnecting started | Show spinner |
| `onError` | Error occurred | Report to Sentry |
| `onLeaderChange` | Tab became/lost leader | Log, adjust behavior |
| `onActive` | Tab became visible | Mark read, refresh data, resume |
| `onInactive` | Tab went to background | Pause polling, animations |
| `onVisibilityChange` | Any visibility change | Generic handler |

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

## Topics — Server-Side Filtered Subscriptions

Subscribe to specific topics so the server only sends relevant events:

```typescript
// Vanilla
ws.subscribe('notifications:orders');
ws.subscribe('notifications:payments');
ws.subscribe(`user:${userId}:mentions`);

// Later — unsubscribe
ws.unsubscribe('notifications:orders');
```

```tsx
// React — auto-subscribe on mount, unsubscribe on unmount
function OrdersDashboard() {
  useTopics(['notifications:orders', 'notifications:payments']);

  const order = useSocketEvent('notifications:orders:new');
  return order ? <div>New order #{order.id}</div> : null;
}

// Dynamic topics
function UserMentions({ userId }: { userId: string }) {
  useTopics([`user:${userId}:mentions`]);
  useSocketCallback(`user:${userId}:mentions:mention`, showMentionToast);
  return null;
}
```

```vue
<!-- Vue — same pattern -->
<script setup>
const props = defineProps<{ userId: string }>();
useTopics([`user:${props.userId}:mentions`]);
useSocketEvent(`user:${props.userId}:mentions:mention`, showToast);
</script>
```

Server receives `$topic:subscribe` / `$topic:unsubscribe` events (configurable via `events.topicSubscribe`).

## Push Notifications

Two modes: **custom render** (sonner, react-hot-toast, your UI) and/or **browser Notification API**.

`target` controls which tab(s) show the notification:

| Target | Behavior | Default for |
|--------|----------|-------------|
| `'active'` | Only the currently visible/focused tab | render (toasts) |
| `'leader'` | Only the leader tab | browser Notification |
| `'all'` | Every tab (critical alerts) | — |

### Custom Render — you control the display

```typescript
// Vanilla — sonner toast (default: target 'active' — visible tab only)
import { toast } from 'sonner';

ws.push('notification', {
  render: (n) => toast(n.title, { description: n.body }),
  // target: 'active' — implicit default
});

ws.push('order.created', {
  render: (order) => toast.success(`New Order #${order.id}`, {
    description: `$${order.total} from ${order.customer}`,
    action: { label: 'View', onClick: () => navigate(`/orders/${order.id}`) },
  }),
});
```

```tsx
// React — sonner
import { toast } from 'sonner';

function NotificationSetup() {
  usePush('notification', {
    render: (n) => toast(n.title, { description: n.body }),
  });

  usePush('order.created', {
    render: (order) => toast.success(`Order #${order.id} — $${order.total}`),
  });

  return null;
}

// React — react-hot-toast
import hotToast from 'react-hot-toast';

function NotificationSetup() {
  usePush('notification', {
    render: (n) => hotToast(n.title),
  });
  return null;
}
```

```vue
<!-- Vue — sonner-vue -->
<script setup>
import { toast } from 'sonner-vue';

usePush('notification', {
  render: (n) => toast(n.title, { description: n.body }),
});

usePush('order.created', {
  render: (order) => toast.success(`Order #${order.id} — $${order.total}`),
});
</script>
```

### Browser Notification API — native OS notifications

```typescript
// Vanilla — browser native (default: target 'leader' — one notification, not N)
ws.push('notification', {
  title: (n) => n.title,
  body: (n) => n.body,
  icon: '/icons/bell.png',
  tag: (n) => `notif-${n.id}`,  // deduplication
  onClick: (n) => window.open(n.url),
  // target: 'leader' — implicit default for native notifications
});
```

```tsx
// React
usePush('order.created', {
  title: (order) => `New Order #${order.id}`,
  body: (order) => `$${order.total}`,
  icon: '/icons/order.png',
  onClick: (order) => navigate(`/orders/${order.id}`),
});
```

```vue
<!-- Vue -->
<script setup>
usePush('order.created', {
  title: (order) => `New Order #${order.id}`,
  body: (order) => `$${order.total}`,
});
</script>
```

### Critical alerts — show in ALL tabs

```typescript
// Vanilla — payment failed: show toast in EVERY tab
ws.push('payment.failed', {
  render: (err) => toast.error(`Payment failed: ${err.message}`),
  target: 'all',  // every tab sees it
});
```

```tsx
// React
usePush('payment.failed', {
  render: (err) => toast.error(`Payment failed: ${err.message}`),
  target: 'all',
});
```

```vue
<!-- Vue -->
<script setup>
usePush('payment.failed', {
  render: (err) => toast.error(`Payment failed: ${err.message}`),
  target: 'all',
});
</script>
```

### Both — toast in UI + browser notification

```typescript
// Active tab gets sonner toast, leader sends native notification
ws.push('order.created', {
  render: (order) => toast.success(`Order #${order.id}`),  // in-app toast
  title: (order) => `New Order #${order.id}`,              // + native notification
  body: (order) => `$${order.total}`,
});
```

## Server-Side Implementation Guide

Complete server reference — what events to listen for and how to respond.

### Message Format

All messages are JSON with two fields (configurable via `events` option):

```
Client → Server: { "event": "event.name", "data": { ... } }
Server → Client: { "event": "event.name", "data": { ... } }
```

### System Events (sent by client automatically)

| Event | When | Payload | Your Server Should |
|-------|------|---------|-------------------|
| `ping` | Every 30s (heartbeat) | `{ "type": "ping" }` | Respond with `{ "type": "pong" }` or ignore |
| `$channel:join` | `ws.channel('name')` | `{ "channel": "chat:room_1" }` | Track which channels this connection belongs to |
| `$channel:leave` | `channel.leave()` | `{ "channel": "chat:room_1" }` | Remove connection from channel |
| `$topic:subscribe` | `ws.subscribe('topic')` | `{ "topic": "notifications:orders" }` | Start sending events for this topic to this connection |
| `$topic:unsubscribe` | `ws.unsubscribe('topic')` | `{ "topic": "notifications:orders" }` | Stop sending events for this topic |

### Node.js (ws) — Complete Server Example

```typescript
import { WebSocketServer, WebSocket } from 'ws';

const wss = new WebSocketServer({ port: 8080 });

// Track per-connection state
interface ClientState {
  userId?: string;
  channels: Set<string>;
  topics: Set<string>;
}

const clients = new Map<WebSocket, ClientState>();

wss.on('connection', (ws, req) => {
  // Extract auth token from URL
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const userId = verifyToken(token);  // your auth logic

  const state: ClientState = {
    userId,
    channels: new Set(),
    topics: new Set(),
  };
  clients.set(ws, state);

  // Send welcome
  send(ws, 'welcome', { userId, timestamp: Date.now() });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const { event, data } = msg;

    switch (event) {
      // ─── System Events ───────────────────────

      case 'ping':
        // Respond to heartbeat (optional — some servers ignore pings)
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      // ─── Channel Events ──────────────────────

      case '$channel:join':
        state.channels.add(data.channel);
        console.log(`${userId} joined ${data.channel}`);
        // Send channel history, presence, etc.
        break;

      case '$channel:leave':
        state.channels.delete(data.channel);
        console.log(`${userId} left ${data.channel}`);
        break;

      // ─── Topic Events ────────────────────────

      case '$topic:subscribe':
        state.topics.add(data.topic);
        console.log(`${userId} subscribed to ${data.topic}`);
        break;

      case '$topic:unsubscribe':
        state.topics.delete(data.topic);
        break;

      // ─── App Events ──────────────────────────

      case 'chat.send':
        // Broadcast to all clients in the same channel
        const channel = data.roomId ? `chat:${data.roomId}` : null;
        broadcastToChannel(channel, 'chat.message', {
          id: crypto.randomUUID(),
          userId: state.userId,
          text: data.text,
          timestamp: Date.now(),
        });
        break;

      case 'chat.typing':
        broadcastToChannel(`chat:${data.roomId}`, 'chat.typing', {
          userId: state.userId,
        }, ws);  // exclude sender
        break;

      default:
        console.log('Unknown event:', event, data);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

// ─── Helpers ─────────────────────────────────────

function send(ws: WebSocket, event: string, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event, data }));
  }
}

function broadcastToChannel(
  channel: string | null,
  event: string,
  data: unknown,
  exclude?: WebSocket,
) {
  for (const [ws, state] of clients) {
    if (ws === exclude) continue;
    if (channel && !state.channels.has(channel)) continue;
    send(ws, event, data);
  }
}

function broadcastToTopic(topic: string, event: string, data: unknown) {
  for (const [ws, state] of clients) {
    if (!state.topics.has(topic)) continue;
    send(ws, `${topic}:${event}`, data);
  }
}

// ─── Example: Send notifications by topic ────────

function notifyNewOrder(order: Order) {
  broadcastToTopic('notifications:orders', 'new', {
    id: order.id,
    total: order.total,
    customer: order.customerName,
  });
  // Only clients who called ws.subscribe('notifications:orders') receive this
}

// ─── Push Notifications ──────────────────────────

// Client listens via: ws.push('notification', { render: ... })
// Server sends 'notification' event — client shows toast/push
function sendPushNotification(
  targetUserId: string,
  notification: { id: string; title: string; body: string; type: string; url?: string },
) {
  for (const [ws, state] of clients) {
    if (state.userId === targetUserId) {
      send(ws, 'notification', notification);
    }
  }
}

// Broadcast push to all connected clients
function broadcastPush(notification: { id: string; title: string; body: string; type: string }) {
  for (const [ws] of clients) {
    send(ws, 'notification', notification);
  }
}

// ─── Usage examples ──────────────────────────────

// After order created — notify the merchant
async function onOrderCreated(order: Order) {
  // 1. Notify via topic (only subscribers)
  broadcastToTopic('notifications:orders', 'new', order);

  // 2. Push notification to specific user
  sendPushNotification(order.merchantId, {
    id: `order-${order.id}`,
    title: `New Order #${order.id}`,
    body: `$${order.total} from ${order.customerName}`,
    type: 'success',
    url: `/orders/${order.id}`,
  });
}

// Payment failed — critical alert to user
async function onPaymentFailed(payment: Payment) {
  sendPushNotification(payment.userId, {
    id: `payment-${payment.id}`,
    title: 'Payment Failed',
    body: `Your payment of $${payment.amount} could not be processed`,
    type: 'error',
    url: `/payments/${payment.id}`,
  });
}

// System maintenance — broadcast to everyone
async function onMaintenanceScheduled(time: string) {
  broadcastPush({
    id: `maintenance-${Date.now()}`,
    title: 'Scheduled Maintenance',
    body: `System will be down for maintenance at ${time}`,
    type: 'warning',
  });
}
```

### Go — Server Example

```go
// Message format
type Message struct {
    Event string          `json:"event"`
    Data  json.RawMessage `json:"data"`
}

// Handle incoming messages
func handleMessage(conn *websocket.Conn, state *ClientState, msg Message) {
    switch msg.Event {
    case "$channel:join":
        var payload struct{ Channel string `json:"channel"` }
        json.Unmarshal(msg.Data, &payload)
        state.Channels[payload.Channel] = true

    case "$channel:leave":
        var payload struct{ Channel string `json:"channel"` }
        json.Unmarshal(msg.Data, &payload)
        delete(state.Channels, payload.Channel)

    case "$topic:subscribe":
        var payload struct{ Topic string `json:"topic"` }
        json.Unmarshal(msg.Data, &payload)
        state.Topics[payload.Topic] = true

    case "$topic:unsubscribe":
        var payload struct{ Topic string `json:"topic"` }
        json.Unmarshal(msg.Data, &payload)
        delete(state.Topics, payload.Topic)

    case "chat.send":
        // broadcast to channel...

    case "ping":
        conn.WriteJSON(Message{Event: "pong"})
    }
}

// Send push notification to specific user
func sendPushNotification(userID string, title, body, notifType string) {
    for conn, state := range clients {
        if state.UserID == userID {
            conn.WriteJSON(Message{
                Event: "notification",
                Data:  json.RawMessage(fmt.Sprintf(
                    `{"id":"%s","title":"%s","body":"%s","type":"%s"}`,
                    uuid.NewString(), title, body, notifType,
                )),
            })
        }
    }
}
```

### PHP (Laravel + Ratchet/Swoole) — Server Example

```php
// Handle incoming WebSocket message
public function onMessage(ConnectionInterface $conn, $msg): void
{
    $data = json_decode($msg, true);
    $event = $data['event'] ?? 'message';
    $payload = $data['data'] ?? [];

    match ($event) {
        '$channel:join' => $this->joinChannel($conn, $payload['channel']),
        '$channel:leave' => $this->leaveChannel($conn, $payload['channel']),
        '$topic:subscribe' => $this->subscribeTopic($conn, $payload['topic']),
        '$topic:unsubscribe' => $this->unsubscribeTopic($conn, $payload['topic']),
        'chat.send' => $this->handleChatMessage($conn, $payload),
        'ping' => $conn->send(json_encode(['type' => 'pong'])),
        default => logger()->warning("Unknown event: {$event}"),
    };
}

// Send to topic subscribers
public function notifyTopic(string $topic, string $event, array $data): void
{
    foreach ($this->connections as $conn) {
        if (in_array($topic, $this->topics[$conn->resourceId] ?? [])) {
            $conn->send(json_encode([
                'event' => "{$topic}:{$event}",
                'data' => $data,
            ]));
        }
    }
}

// Send push notification to user
public function sendPushNotification(string $userId, array $notification): void
{
    foreach ($this->connections as $conn) {
        if ($this->getUserId($conn) === $userId) {
            $conn->send(json_encode([
                'event' => 'notification',
                'data' => $notification,
            ]));
        }
    }
}

// Usage:
// $this->sendPushNotification($order->merchant_id, [
//     'id' => Str::uuid(),
//     'title' => "New Order #{$order->id}",
//     'body' => "\${$order->total} from {$order->customer_name}",
//     'type' => 'success',
//     'url' => "/orders/{$order->id}",
// ]);
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
  useTopics,
  usePush,
} from '@gwakko/shared-websocket/react';
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
  useTopics,
  usePush,
  SharedWebSocketKey,
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
