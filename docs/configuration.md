# Configuration

Reconnection, serialization, protocols, middleware, debug mode, and worker configuration.

[← Back to README](../README.md)

## Table of Contents

- [Reconnection](#reconnection)
- [Custom Serialization](#custom-serialization)
  - [Per-Event Serialization](#per-event-serialization)
  - [Global Serialization Examples](#global-serialization-examples)
  - [Custom Worker with Binary Serialization](#custom-worker-with-binary-serialization)
  - [How Serialization Works with Worker Mode](#how-serialization-works-with-worker-mode)
- [Custom Event Protocol](#custom-event-protocol)
- [Middleware](#middleware)
- [Debug Mode & Custom Logger](#debug-mode--custom-logger)
- [Worker Mode](#worker-mode)

## Reconnection

Auto-reconnect uses **exponential backoff with ±25% jitter** to prevent thundering herd when many clients reconnect simultaneously.

```
Attempt  Base delay  With jitter (±25%)
  1        1s         0.75s – 1.25s
  2        2s         1.50s – 2.50s
  3        4s         3.00s – 5.00s
  4        8s         6.00s – 10.0s
  5       16s        12.00s – 20.0s
  6       30s (max)  22.50s – 30.0s  ← capped at reconnectMaxDelay
  7       30s        22.50s – 30.0s
  ...     ...        ...
```

**Default behavior** — retries forever with increasing delays:

```typescript
new SharedWebSocket('wss://api.example.com/ws');
// reconnect: true (default)
// reconnectMaxDelay: 30_000 (default, 30s max backoff)
// reconnectMaxRetries: Infinity (default, never gives up)
```

**Limit retries** — give up after N attempts:

```typescript
new SharedWebSocket('wss://api.example.com/ws', {
  reconnectMaxRetries: 5,     // give up after 5 failed attempts
  reconnectMaxDelay: 10_000,  // cap backoff at 10s
});

// Sequence: ~1s → ~2s → ~4s → ~8s → ~10s → failed
// After 5 failures: state → 'failed', onReconnectFailed fires (then onDisconnect)
```

### Recovering after max retries

When auto-reconnect gives up, the library exposes:

- **`onReconnectFailed`** — lifecycle hook that fires once retries are exhausted. Use it to surface a UI (snackbar, banner, modal).
- **`ws.reconnect()`** — imperative API that resets the retry counter and forces a fresh attempt. Call it from the user's "Reconnect" button.
- **Auto-reset on success** — the retry counter resets to `0` whenever a connection succeeds, so a transient drop doesn't shorten the next round of retries.

`ws.reconnect()` is also safe to call any time (e.g., from a "Refresh" button while still in `reconnecting`) — it cancels the pending backoff and connects immediately. Followers route the request to the leader tab automatically via BroadcastChannel.

**Vanilla — snackbar with reconnect button:**

```typescript
const ws = new SharedWebSocket('wss://api.example.com/ws', {
  reconnectMaxRetries: 5,
});

ws.onReconnectFailed(() => {
  const bar = document.createElement('div');
  bar.className = 'snackbar';
  bar.innerHTML = `Connection lost. <button>Reconnect</button>`;
  bar.querySelector('button')!.addEventListener('click', () => {
    ws.reconnect();   // resets retry counter, tries fresh connection
    bar.remove();
  });
  document.body.appendChild(bar);
});

ws.onConnect(() => {
  document.querySelector('.snackbar')?.remove();
});

ws.connect();
```

**React — `useSocketReconnect` hook:**

```tsx
import { useSocketReconnect } from '@gwakko/shared-websocket/react';

function ConnectionBanner() {
  const { hasFailed, reconnect } = useSocketReconnect();
  if (!hasFailed) return null;
  return (
    <div className="snackbar">
      <span>Connection lost.</span>
      <button onClick={reconnect}>Reconnect</button>
    </div>
  );
}

// Mount once near the root:
// <ConnectionBanner />
```

Or via `useSocketLifecycle` if you'd rather drive a toast library directly:

```tsx
import { useSocketLifecycle, useSharedWebSocket } from '@gwakko/shared-websocket/react';
import { toast } from 'sonner';

function App() {
  const ws = useSharedWebSocket();
  useSocketLifecycle({
    onReconnecting: () => toast.loading('Reconnecting…', { id: 'ws' }),
    onConnect: () => toast.success('Connected', { id: 'ws' }),
    onReconnectFailed: () => {
      toast.error('Connection lost', {
        id: 'ws',
        duration: Infinity,
        action: { label: 'Reconnect', onClick: () => ws.reconnect() },
      });
    },
  });
  return null;
}
```

**Vue — `useSocketReconnect` composable:**

```vue
<script setup lang="ts">
import { useSocketReconnect } from '@gwakko/shared-websocket/vue';

const { hasFailed, reconnect } = useSocketReconnect();
</script>

<template>
  <div v-if="hasFailed" class="snackbar">
    <span>Connection lost.</span>
    <button @click="reconnect">Reconnect</button>
  </div>
</template>
```

Or wire into a toast library via `useSocketLifecycle`:

```vue
<script setup lang="ts">
import { useSocketLifecycle, useSharedWebSocket } from '@gwakko/shared-websocket/vue';
import { useToast } from 'vue-toastification';

const ws = useSharedWebSocket();
const toast = useToast();

useSocketLifecycle({
  onReconnecting: () => toast.info('Reconnecting…'),
  onConnect: () => toast.success('Connected'),
  onReconnectFailed: () => {
    toast.error('Connection lost. Click to reconnect.', {
      timeout: false,
      onClick: () => ws.reconnect(),
    });
  },
});
</script>
```

**Disable auto-reconnect entirely:**

```typescript
new SharedWebSocket('wss://api.example.com/ws', {
  reconnect: false,  // no auto-reconnect, closes immediately
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `reconnect` | `boolean` | `true` | Enable auto-reconnect |
| `reconnectMaxDelay` | `number` | `30000` | Max backoff in ms (caps exponential growth) |
| `reconnectMaxRetries` | `number` | `Infinity` | Max attempts before giving up |
| `authFailureCloseCodes` | `number[]` | `[1008]` | Close codes that mean "auth failed; stop retry" |
| `outboundBufferSize` | `number` | `100` | Per-tab follower-dispatch buffer for leader-handover replay |

### Outbound buffer & leader handover

When a follower tab calls `ws.send(...)` (or any other dispatch), the
frame is published over `BroadcastChannel` and the leader writes it to
the socket. If the leader tab dies between receiving the dispatch and
writing it, the frame would normally be lost.

The library buffers each follower-originated dispatch locally with a
unique id. The leader broadcasts a `flushed` signal once it processes
the dispatch, and the originator drops the entry. On leader change,
the new leader gathers still-pending entries from every surviving tab
and replays them over the fresh socket — so subscriptions (replayed
first, see #5b) and in-flight sends both survive promotion.

**Caveats:**
- The buffer is capped (`outboundBufferSize`, default 100). When full,
  the oldest entry is dropped. Set to `0` to disable buffering entirely.
- Replay is **at-least-once**. A leader that dies after `socket.send`
  but before broadcasting `flushed` causes the new leader to re-send.
  Make server-side handlers idempotent (e.g. dedupe by message id) if
  duplicate effects would matter.
- Leader-originated sends are not buffered — when a leader dies its
  own state is gone anyway; nothing to replay to.

## Idle Tab Recovery (stuck-leader takeover)

Browsers aggressively throttle `setInterval`/`setTimeout` in backgrounded
tabs (often down to once per minute, and freezing them entirely under
memory pressure / bfcache). If the **leader** tab is the one that gets
backgrounded, two things happen:

1. Its heartbeat slows or stops, and its WebSocket can be silently killed
   by the OS/network without the tab's JS running to notice.
2. Followers' own leader-timeout checks are *also* throttled, so they may
   not notice the leader went stale before you switch back to them.

The net effect: you return to a previously-idle tab and the connection is
**stuck** — the dead leader still "holds" leadership, so a normal election
keeps deferring to it.

To fix this, a tab verifies real leader health (not just "did a heartbeat
arrive") through a `BroadcastChannel` ping/pong. A leader only answers a
ping while its socket is genuinely `connected`, so a zombie leader stays
silent and gets replaced. The check runs from **two independent triggers**,
which together cover every layout:

- **When a tab becomes visible again** (`visibilitychange`). A follower
  pings the leader and waits up to `leaderPingTimeout` (default `1500` ms);
  if no healthy leader answers it forces the stuck leader to step down and
  **takes over** the connection. A leader re-checks its own socket and
  reconnects in place if it died while backgrounded.
- **From the follower's heartbeat-staleness check**, which keeps running on
  any tab that *stays* active. This is the important one for your reported
  case: the current tab is a follower that was active the whole time while a
  *different*, backgrounded tab held a now-dead leader socket — there is no
  visibility change to react to, but the staleness timer notices the lapsed
  heartbeat, pings for real health, and takes over. (Previously this path
  blindly re-elected, so a zombie leader could still reject the election and
  leave the connection stuck.)

> The remaining case — a leader that *keeps running at full speed* (e.g.
> visible on a second monitor) yet whose socket has *silently died* (no close
> frame) — is **not** caught by leader verification, because the leader still
> reports `state === 'connected'` and answers the ping. Detecting that
> requires the socket-level liveness watchdog: set **`heartbeatTimeout`** (see
> below). Without it, the dead socket lingers until the OS TCP timeout
> eventually fires `onclose` (often minutes).

### `heartbeatTimeout` — detect silently-dead sockets

The connection heartbeat (`heartbeatInterval`, default 30s) is **send-only by
default** — it pushes a ping but never checks for a reply. A connection that
dies without a close frame (laptop sleep, Wi-Fi → cellular handoff, captive
portal, NAT timeout) therefore stays `connected` in the library's eyes until
the OS gives up on the TCP socket, which can take minutes.

Set `heartbeatTimeout` (ms) to enable a watchdog: if **no inbound message**
(server data *or* a pong) arrives within the window, the socket force-
reconnects immediately.

```typescript
const ws = new SharedWebSocket('wss://api.example.com/ws', {
  heartbeatInterval: 15000,  // send a ping every 15s
  heartbeatTimeout: 35000,   // ...reconnect if nothing comes back in 35s
});
```

Requirements & guidance:
- Your server must send periodic data **or** answer the heartbeat ping (any
  inbound frame resets the timer). If the server can be legitimately silent
  for long stretches and never pongs, leave this disabled or it will
  reconnect spuriously.
- Set it comfortably above `heartbeatInterval` (≈2–3×) to tolerate one missed
  beat plus latency.
- Default: **disabled** (`0`) — preserves the legacy fire-and-forget behavior.
- Works in both main-thread and `useWorker: true` modes.

This is **on by default** — no configuration needed. Two knobs tune it:

```typescript
const ws = new SharedWebSocket('wss://api.example.com/ws', {
  // How long an active tab waits for the leader's pong before taking over.
  // Raise it on slow machines if you see unnecessary handovers; lower it
  // for faster recovery. Default: 1500ms.
  leaderPingTimeout: 1500,

  // Master switch for the whole active-tab recovery behavior. Set false to
  // rely purely on heartbeat timeout (not recommended for long-idle tabs).
  recoverOnActivate: true,
});
```

Pair it with `onActive` if you want to react in the UI when a tab wakes up
(e.g. show a "reconnecting…" hint while takeover completes):

```typescript
ws.onActive(() => {
  // Fires when this tab becomes visible. Leader verification has already
  // been kicked off internally; use this for your own refresh logic.
  if (!ws.connected) showReconnectingHint();
});
```

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
| `frameBuilder` | _none_ | Full control over outgoing wire shape per `FrameKind`. See below. |

### `frameBuilder` — full control over the outgoing envelope

The defaults above all assume a two-key envelope:
`{ [eventField]: <name>, [dataField]: <data> }`. That works for Pusher,
Soketi, Phoenix-with-tweaks, and most hand-rolled servers — but if your
server has more than two top-level fields (e.g. `type` discriminator
**plus** `channel` **plus** `event` **plus** `data`), there's no
arrangement of `eventField`/`dataField` that produces it.

`frameBuilder` is the escape hatch. It receives a typed `FrameKind` and
a structured `FramePayload`, and returns the JSON value that goes on the
wire. Channel join/leave, topic subscribe, auth login/logout, and user
events all flow through it — so you write the wire shape **once** and
every kind of frame matches.

```typescript
import { SharedWebSocket, type FrameKind, type FramePayload } from '@gwakko/shared-websocket';

new SharedWebSocket(url, {
  events: {
    frameBuilder: (kind: FrameKind, p: FramePayload) => {
      switch (kind) {
        case 'subscribe':         return { type: 'subscribe',   channel: p.channel };
        case 'unsubscribe':       return { type: 'unsubscribe', channel: p.channel };
        case 'topic-subscribe':   return { type: 'topic.subscribe',   topic: p.topic };
        case 'topic-unsubscribe': return { type: 'topic.unsubscribe', topic: p.topic };
        case 'auth-login':        return { type: 'auth',   token: p.data };
        case 'auth-logout':       return { type: 'logout' };
        case 'event':
          return p.channel
            ? { type: 'event', channel: p.channel, event: p.event, data: p.data, ...p.extras }
            : { type: 'event', event: p.event, data: p.data, ...p.extras };
      }
    },
  },
});

// On the wire:
ws.send('msg', { text: 'hi' });
// → { type: 'event', event: 'msg', data: { text: 'hi' } }

ws.channel('public.group.x').send('member_ready', { id: 1 });
// → { type: 'event', channel: 'public.group.x', event: 'member_ready', data: { id: 1 } }

ws.subscribe('orders');
// → { type: 'topic.subscribe', topic: 'orders' }
```

`FrameKind` values: `'event'`, `'subscribe'`, `'unsubscribe'`,
`'topic-subscribe'`, `'topic-unsubscribe'`, `'auth-login'`, `'auth-logout'`.
`FramePayload` carries `channel?`, `topic?`, `event?`, `data?`, `extras?` —
populated based on kind (see TypeScript types for the per-kind shape).

**Heartbeats are not built via `frameBuilder`** — they ship the constant
`events.ping` value as-is so they can run inside the Web Worker without
crossing back to the main thread. Configure ping shape via `events.ping`.

**Return-value contract:**
- a concrete value → that becomes the wire frame
- `null` → drop the frame intentionally (filter / no-op)
- `undefined` → fall back to the library default for this kind

The `undefined` fallback lets you override only the kinds that differ
from the default. Use `null` (not `undefined`) when you actually want
the frame dropped.

### Server compatibility samples

Worked configurations for common server protocols. Each is a starting
point — wire formats vary by version, so verify against your server.

#### Pusher / Soketi / Reverb (Pusher protocol)

The default frame shape works; just override the control-frame names:

```typescript
new SharedWebSocket('wss://ws.pusherapp.com/app/KEY?protocol=7&client=js&version=4.4', {
  events: {
    channelJoin: 'pusher:subscribe',
    channelLeave: 'pusher:unsubscribe',
    ping: { event: 'pusher:ping', data: {} },
    authLogin: 'pusher:auth',
  },
});

ws.channel('presence-room-1');
// → { event: 'pusher:subscribe', data: { channel: 'presence-room-1' } }

ws.send('client-typing', { user: 'alice' });
// → { event: 'client-typing', data: { user: 'alice' } }
```

For private/presence channels with signed auth, hook the auth signature
into the `subscribe` frame via `frameBuilder`:

```typescript
events: {
  frameBuilder: (kind, p) => {
    if (kind === 'subscribe') {
      const channel = p.channel!;
      return {
        event: 'pusher:subscribe',
        data: channel.startsWith('private-') || channel.startsWith('presence-')
          ? { channel, auth: signChannel(channel) }
          : { channel },
      };
    }
    // Defer everything else to library-default behavior by reproducing it inline:
    return undefined; // or hand-build per kind — see types.ts FrameKind
  },
}
```

#### Flat-fields server (e.g. custom Go or Rust WS)

Useful when the server expects every routing field at the top level:

```typescript
import { SharedWebSocket, type FrameKind, type FramePayload } from '@gwakko/shared-websocket';

new SharedWebSocket('wss://api.example.com/ws', {
  events: {
    eventField: 'event',
    dataField: 'data',
    frameBuilder: (kind: FrameKind, p: FramePayload) => {
      switch (kind) {
        case 'subscribe':         return { type: 'subscribe',   channel: p.channel };
        case 'unsubscribe':       return { type: 'unsubscribe', channel: p.channel };
        case 'topic-subscribe':   return { type: 'topic.subscribe',   topic: p.topic };
        case 'topic-unsubscribe': return { type: 'topic.unsubscribe', topic: p.topic };
        case 'auth-login':        return { type: 'auth',   token: p.data };
        case 'auth-logout':       return { type: 'logout' };
        case 'event':
          return p.channel
            ? { type: 'event', channel: p.channel, event: p.event, data: p.data, ...p.extras }
            : { type: 'event', event: p.event, data: p.data, ...p.extras };
      }
    },
  },
});
```

Incoming messages keep arriving in the library's expected shape — make
sure your server emits `event` and `data` fields (or override
`eventField`/`dataField` to match what it does emit).

#### ActionCable (Rails)

ActionCable identifies channels with a JSON-stringified identifier
object and wraps user data with a `command: "message"` envelope. Auth
is typically handled by the Rails session cookie on the WS upgrade —
the library's `auth-login` / `auth-logout` frames are no-ops here.

```typescript
new SharedWebSocket('wss://example.com/cable', {
  events: {
    ping: { type: 'ping' },
    frameBuilder: (kind, p) => {
      switch (kind) {
        case 'subscribe':
          // p.channel is whatever you passed to ws.channel(...) — usually
          // a JSON.stringify of the identifier ({ channel, ...params }).
          return { command: 'subscribe', identifier: p.channel };
        case 'unsubscribe':
          return { command: 'unsubscribe', identifier: p.channel };
        case 'event':
          return {
            command: 'message',
            identifier: p.channel ?? '',
            data: JSON.stringify({ action: p.event, ...(p.data as object ?? {}) }),
          };
        // Auth via cookie — drop these
        case 'auth-login':
        case 'auth-logout':
          return null;
        default:
          return null;
      }
    },
  },
});

const chat = ws.channel(JSON.stringify({ channel: 'ChatChannel', room: 'general' }));
chat.send('speak', { text: 'Hello!' });
// → { command: 'message', identifier: '...', data: '{"action":"speak","text":"Hello!"}' }
```

You'll likely also want a custom `deserialize` since ActionCable wraps
inbound messages in `{ identifier, message }` — strip that envelope so
the library sees `{ event, data }` (or override `eventField`/`dataField`
to match).

#### Phoenix Channels (Elixir)

Phoenix uses an array form `[join_ref, ref, topic, event, payload]` (v2
default) and replies with `phx_reply` events whose `payload.status`
indicates success. The structural sample below is a starting point;
ref tracking depends on your phoenix client version.

```typescript
let _ref = 0;
const nextRef = () => String(++_ref);
const joinRefs = new Map<string, string>(); // topic → join_ref

new SharedWebSocket('wss://example.com/socket/websocket?vsn=2.0.0', {
  events: {
    ping: [null, null, 'phoenix', 'heartbeat', {}],
    frameBuilder: (kind, p) => {
      switch (kind) {
        case 'subscribe': {
          const ref = nextRef();
          joinRefs.set(p.channel!, ref);
          return [ref, ref, p.channel, 'phx_join', {}];
        }
        case 'unsubscribe':
          return [joinRefs.get(p.channel!) ?? null, nextRef(), p.channel, 'phx_leave', {}];
        case 'event':
          return [joinRefs.get(p.channel!) ?? null, nextRef(), p.channel ?? '', p.event ?? '', p.data ?? {}];
        case 'auth-login':
        case 'auth-logout':
          return null; // auth is part of the connect URL in Phoenix
      }
    },
    channelAckMatcher: (frame, channel) => {
      if (!Array.isArray(frame)) return 'pending';
      const [, , topic, event, payload] = frame as [unknown, unknown, string, string, { status?: string }];
      if (topic !== channel || event !== 'phx_reply') return 'pending';
      return payload?.status === 'ok' ? 'ok' : 'reject';
    },
    channelAckTimeout: 3000,
  },
});

const room = ws.channel('rooms:lobby');
await room.ready; // resolves on phx_reply ok, rejects on error or timeout
room.on('new_msg', renderMsg);
```

You'll also want a custom `deserialize` to convert inbound array frames
back to `{ event, data }` so library-level event routing works.

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
// [SharedWS] → send subscribe chat:room_42 { payload: {channel:'chat:room_42'}, frame: {event:'$channel:join', data:{...}} }
// [SharedWS] → send event chat.message      { payload: {event:'chat.message', data:{text:'hi'}}, frame: {event:'chat.message', data:{text:'hi'}} }
// [SharedWS] ← recv chat.message            { data: {text:'hello'}, raw: {event:'chat.message', data:{text:'hello'}} }
// [SharedWS] → send auth-login (token redacted)
// [SharedWS] ✗ outgoing dropped by middleware event chat.message
// [SharedWS] 🔄 reconnecting

// Each send line shows: kind, headline (event/channel/topic), then a
// detail object with both the structured `payload` (input you provided
// to ws.send / channel.send / etc.) and the actual `frame` that went on
// the wire. With a custom frameBuilder these can differ; with the
// default builder they're equivalent except for control frames.
// Auth frames are never logged with their token contents.

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

### What level does the library log at?

This matters when wiring the logger to alerting (Sentry, Datadog, etc.) —
you don't want expected-state messages to page on-call.

| Level | What the library emits |
|-------|------------------------|
| `debug` | Per-event traffic: `→ send`, `← recv`, middleware drops, tab visibility, init details. High-volume — keep this off in production unless you're investigating something specific. |
| `info` | One-shot lifecycle: `becameLeader`, `connected`, state transitions, `authenticated`, `manual reconnect`. Low-volume, useful as breadcrumbs. |
| `warn` | Server-initiated auth revocation. Today this is the only `warn` site. |
| `error` | **The library does not call `error` itself.** Reserved for user logger overrides — feel free to call it from middleware or your own handlers. |

Practical implication for the Sentry mapping above: routing `error → captureException` is safe because the library never triggers it as a result of expected reconnect/election behavior. Routing `warn → captureException` would also work today (single site, real signal). Routing `info → captureException` would page on every leader election.

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
