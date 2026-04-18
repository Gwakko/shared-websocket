# Configuration

Serialization, protocols, middleware, debug mode, and worker configuration.

[← Back to README](../README.md)

## Table of Contents

- [Custom Serialization](#custom-serialization)
  - [Per-Event Serialization](#per-event-serialization)
  - [Global Serialization Examples](#global-serialization-examples)
  - [Custom Worker with Binary Serialization](#custom-worker-with-binary-serialization)
  - [How Serialization Works with Worker Mode](#how-serialization-works-with-worker-mode)
- [Custom Event Protocol](#custom-event-protocol)
- [Middleware](#middleware)
- [Debug Mode & Custom Logger](#debug-mode--custom-logger)
- [Worker Mode](#worker-mode)

## Custom Serialization

By default all messages are serialized/deserialized as JSON. Override for binary formats.

**Where serialization fits in the pipeline:**

```
Outgoing:
  ws.send(event, data)
    → build payload object { event, data }
    → outgoing middleware (operates on object)
    → serialize(payload) → string | ArrayBuffer    ← HERE
    → WebSocket.send(serialized)

Incoming:
  WebSocket.onmessage(raw)
    → global deserialize(raw) → object              ← global
    → incoming middleware (operates on object)
    → extract event name + data
    → per-event deserializer(data)                   ← per-event
    → emit to handlers
```

**Global** serialize/deserialize handles wire format (JSON, MessagePack, etc).
**Per-event** serializer/deserializer transforms specific event data (Protobuf for one event, raw binary for another).
**Middleware** operates on deserialized objects — for cross-cutting concerns (timestamps, filtering, logging).

### Per-Event Serialization

Register custom serializers/deserializers for specific events. Everything else uses global serializer (default: JSON).

```typescript
// File uploads — binary, everything else — JSON
ws.serializer('file.upload', (data) => data as ArrayBuffer);
ws.deserializer('file.download', (data) => new Uint8Array(data as ArrayBuffer));

// Protobuf for high-frequency trading events
ws.serializer('trading.order', (data) => OrderProto.encode(data).finish());
ws.deserializer('trading.tick', (data) => TickProto.decode(data as Uint8Array));

// Compress large payloads for specific events
ws.serializer('analytics.batch', (data) => compress(data));
ws.deserializer('analytics.batch', (data) => decompress(data));

// Chain with global — global JSON handles the envelope, per-event handles the data field
// { "event": "trading.order", "data": <protobuf bytes> }
```

```tsx
// React — register in a setup component
function SetupSerializers() {
  const ws = useSharedWebSocket();

  useEffect(() => {
    ws.serializer('file.upload', (data) => data as ArrayBuffer);
    ws.deserializer('file.download', (data) => new Uint8Array(data as ArrayBuffer));
  }, [ws]);

  return null;
}
```

```vue
<!-- Vue — register in setup -->
<script setup>
const ws = useSharedWebSocket();
ws.serializer('file.upload', (data) => data as ArrayBuffer);
ws.deserializer('file.download', (data) => new Uint8Array(data as ArrayBuffer));
</script>
```

Chainable:
```typescript
ws.serializer('file.upload', toBinary)
  .serializer('trading.order', toProtobuf)
  .deserializer('trading.tick', fromProtobuf)
  .deserializer('file.download', toBlobUrl);
```

### Global Serialization Examples

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

### How Serialization Works with Worker Mode

Worker only handles **global** serialization (wire format). **Per-event** serializers run in main thread — Worker doesn't need to know about them.

```
Outgoing (useWorker: true):

  Main thread                              Worker
  ──────────                              ──────
  ws.send('trading.order', data)
    │
    ├─ per-event serializer(data)          
    │  (protobuf for this event)           
    │                                      
    ├─ outgoing middleware(payload)         
    │                                      
    ├─ postMessage(payload) ──────────►  receive payload
    │                                      │
    │                                      ├─ global serialize (JSON/msgpack)
    │                                      │  (from worker template)
    │                                      │
    │                                      └─ WebSocket.send(bytes)


Incoming (useWorker: true):

  Worker                                   Main thread
  ──────                                   ──────────
  WebSocket.onmessage(bytes)
    │
    ├─ global deserialize (JSON/msgpack)
    │  (from worker template)
    │
    ├─ postMessage(object) ──────────────►  receive object
    │                                        │
    │                                        ├─ incoming middleware(object)
    │                                        │
    │                                        ├─ extract event name
    │                                        │
    │                                        ├─ per-event deserializer(data)
    │                                        │  (protobuf for this event)
    │                                        │
    │                                        └─ emit to handlers
```

**Summary:**
- **Worker template** — edit `serialize`/`deserialize` for **wire format** (JSON, MessagePack, Protobuf-everywhere)
- **`ws.serializer(event, fn)`** — runs in **main thread**, for per-event data transforms
- They compose: Worker handles bytes <-> objects, per-event handles specific event data transforms
- Per-event serializers work identically with or without Worker mode

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
| `topicSubscribe` | `"$topic:subscribe"` | Event sent when subscribing to a topic |
| `topicUnsubscribe` | `"$topic:unsubscribe"` | Event sent when unsubscribing from a topic |
| `authLogin` | `"$auth:login"` | Event sent on `authenticate(token)` |
| `authLogout` | `"$auth:logout"` | Event sent on `deauthenticate()` |
| `authRevoked` | `"$auth:revoked"` | Event server sends to revoke auth |

## Middleware

Transform or inspect messages before send / after receive.

**Processing order:**

```
Outgoing: ws.send(event, data)
  → per-event serializer(data)     ← if registered for this event
  → build payload { event, data }
  → outgoing middleware(payload)   ← transform/inspect/drop
  → global serialize(payload)      ← JSON.stringify / msgpack / etc
  → WebSocket.send()

Incoming: WebSocket.onmessage(raw)
  → global deserialize(raw)        ← JSON.parse / msgpack / etc
  → incoming middleware(object)    ← transform/inspect/drop
  → extract event + data
  → per-event deserializer(data)   ← if registered for this event
  → emit to handlers
```

> Middleware works with **deserialized objects** (not raw bytes). Serialization happens at the transport layer — middleware operates on structured data before serialization (outgoing) or after deserialization (incoming).

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

## Worker Mode

Run the WebSocket in a Web Worker to keep the main thread free for rendering.

### How It Works

1. **Leader Election** — new tab broadcasts election request via BroadcastChannel. If no rejection in 200ms -> becomes leader. Leader sends heartbeat every 2s. No heartbeat for 5s -> new election.

2. **Message Flow** — follower calls `send()` -> message goes to BroadcastChannel -> leader picks it up -> forwards to WebSocket -> server response -> leader broadcasts to all tabs.

3. **Failover** — leader tab closes -> `beforeunload` fires `abdicate` -> followers detect missing heartbeat -> election -> new leader connects WebSocket -> zero data loss (buffered messages replayed).

4. **Resource Safety** — `withSocket()` for scoped lifecycle, `Symbol.dispose` support. All timers, listeners, and channels properly cleaned up.

5. **Worker Mode** (optional) — `useWorker: true` runs WebSocket inside a Web Worker. JSON parsing, heartbeat timers, and reconnection logic run off main thread. UI stays responsive even at high message rates.

### When to Use `useWorker: true`

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
