# Server-Side Implementation Guide

Complete server reference for integrating with Shared WebSocket clients.

[← Back to README](../README.md)

## Table of Contents

- [Message Format](#message-format)
- [System Events](#system-events-sent-by-client-automatically)
- [Node.js (ws) — Complete Server Example](#nodejs-ws--complete-server-example)
- [Go — Server Example](#go--server-example)
- [PHP (Laravel + Ratchet/Swoole) — Server Example](#php-laravel--ratchetswoole--server-example)
- [Global Custom Serialization (MessagePack)](#global-custom-serialization-messagepack)
- [Per-Event Serialization (mixed JSON + binary)](#per-event-serialization-mixed-json--binary)

## Message Format

All messages are JSON with two fields (configurable via `events` option):

```
Client → Server: { "event": "event.name", "data": { ... } }
Server → Client: { "event": "event.name", "data": { ... } }
```

## System Events (sent by client automatically)

| Event | When | Payload | Your Server Should |
|-------|------|---------|-------------------|
| `ping` | Every 30s (heartbeat) | `{ "type": "ping" }` | Respond with `{ "type": "pong" }` or ignore |
| `$channel:join` | `ws.channel('name')` | `{ "channel": "chat:room_1" }` | Track which channels this connection belongs to |
| `$channel:leave` | `channel.leave()` | `{ "channel": "chat:room_1" }` | Remove connection from channel |
| `$topic:subscribe` | `ws.subscribe('topic')` | `{ "topic": "notifications:orders" }` | Start sending events for this topic to this connection |
| `$topic:unsubscribe` | `ws.unsubscribe('topic')` | `{ "topic": "notifications:orders" }` | Stop sending events for this topic |
| `$auth:login` | `ws.authenticate(token)` | `{ "token": "jwt..." }` | Verify token, set authenticated state for this connection |
| `$auth:logout` | `ws.deauthenticate()` | `{}` | Clear auth state, remove from auth-required channels/topics |

### Server → Client Events

| Event | When | Payload | Effect |
|-------|------|---------|--------|
| `$auth:revoked` | Token expired, user kicked | `{ "reason": "token_expired" }` | Client auto-leaves auth channels/topics, sets `isAuthenticated = false` |

## Node.js (ws) — Complete Server Example

```typescript
import { WebSocketServer, WebSocket } from 'ws';

const wss = new WebSocketServer({ port: 8080 });

// Track per-connection state
interface ClientState {
  userId?: string;
  authenticated: boolean;
  channels: Set<string>;
  topics: Set<string>;
}

const clients = new Map<WebSocket, ClientState>();

wss.on('connection', (ws, req) => {
  // Optional: extract auth token from URL (connect-time auth)
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const user = token ? verifyToken(token) : null;

  const state: ClientState = {
    userId: user?.id,
    authenticated: !!user,
    channels: new Set(),
    topics: new Set(),
  };
  clients.set(ws, state);

  // Send welcome (works for guests too)
  send(ws, 'welcome', {
    userId: state.userId ?? null,
    authenticated: state.authenticated,
    timestamp: Date.now(),
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const { event, data } = msg;

    switch (event) {
      // ─── System Events ───────────────────────

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      // ─── Auth Events ─────────────────────────

      case '$auth:login': {
        const user = verifyToken(data.token);
        if (!user) {
          send(ws, '$auth:revoked', { reason: 'invalid_token' });
          break;
        }
        state.userId = user.id;
        state.authenticated = true;
        console.log(`${user.id} authenticated via runtime auth`);
        // Optionally send confirmation with user data
        send(ws, 'auth.ok', { userId: user.id, roles: user.roles });
        break;
      }

      case '$auth:logout':
        console.log(`${state.userId} deauthenticated`);
        // Clean up ALL auth-related state for this connection
        state.channels.clear();
        state.topics.clear();
        state.userId = undefined;
        state.authenticated = false;
        break;

      // ─── Channel Events ──────────────────────

      case '$channel:join':
        // Guard: private channels require auth
        if (isPrivateChannel(data.channel) && !state.authenticated) {
          send(ws, 'error', { message: 'Authentication required', channel: data.channel });
          break;
        }
        state.channels.add(data.channel);
        console.log(`${state.userId ?? 'guest'} joined ${data.channel}`);
        break;

      case '$channel:leave':
        state.channels.delete(data.channel);
        console.log(`${state.userId ?? 'guest'} left ${data.channel}`);
        break;

      // ─── Topic Events ────────────────────────

      case '$topic:subscribe':
        // Guard: some topics require auth
        if (isPrivateTopic(data.topic) && !state.authenticated) {
          send(ws, 'error', { message: 'Authentication required', topic: data.topic });
          break;
        }
        state.topics.add(data.topic);
        console.log(`${state.userId ?? 'guest'} subscribed to ${data.topic}`);
        break;

      case '$topic:unsubscribe':
        state.topics.delete(data.topic);
        break;

      // ─── App Events (public) ─────────────────

      case 'chat.send': {
        const channel = data.roomId ? `chat:${data.roomId}` : null;
        broadcastToChannel(channel, 'chat.message', {
          id: crypto.randomUUID(),
          userId: state.userId ?? 'guest',
          text: data.text,
          timestamp: Date.now(),
        });
        break;
      }

      case 'chat.typing':
        broadcastToChannel(`chat:${data.roomId}`, 'chat.typing', {
          userId: state.userId ?? 'guest',
        }, ws);
        break;

      // ─── App Events (auth required) ──────────

      case 'order.create':
        if (!requireAuth(ws, state)) break;
        // ... create order logic
        break;

      case 'profile.update':
        if (!requireAuth(ws, state)) break;
        // ... update profile logic
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

/** Guard — returns false and sends error if not authenticated */
function requireAuth(ws: WebSocket, state: ClientState): boolean {
  if (!state.authenticated) {
    send(ws, 'error', { message: 'Authentication required' });
    return false;
  }
  return true;
}

function isPrivateChannel(channel: string): boolean {
  // Convention: private channels start with "private:" or "user:"
  return channel.startsWith('private:') || channel.startsWith('user:');
}

function isPrivateTopic(topic: string): boolean {
  // Convention: user-specific topics require auth
  return topic.startsWith('user:') || topic.startsWith('notifications:');
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

// ─── Auth Revocation ─────────────────────────────

/** Revoke auth for a specific user (token expired, admin action) */
function revokeUser(userId: string, reason: string) {
  for (const [ws, state] of clients) {
    if (state.userId === userId) {
      send(ws, '$auth:revoked', { reason });
      // Server-side cleanup
      state.channels.clear();
      state.topics.clear();
      state.userId = undefined;
      state.authenticated = false;
    }
  }
}

// Token expiry check (run on interval or middleware)
function checkTokenExpiry(ws: WebSocket, state: ClientState) {
  if (state.authenticated && state.userId) {
    const valid = isTokenStillValid(state.userId);
    if (!valid) {
      send(ws, '$auth:revoked', { reason: 'token_expired' });
      state.channels.clear();
      state.topics.clear();
      state.userId = undefined;
      state.authenticated = false;
    }
  }
}

// ─── Push Notifications ──────────────────────────

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

function broadcastPush(notification: { id: string; title: string; body: string; type: string }) {
  for (const [ws] of clients) {
    send(ws, 'notification', notification);
  }
}

// ─── Usage examples ──────────────────────────────

// After order created — notify the merchant
async function onOrderCreated(order: Order) {
  broadcastToTopic('notifications:orders', 'new', order);

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

// Admin kicks user — revoke across all their connections
async function onUserBanned(userId: string) {
  revokeUser(userId, 'account_suspended');
}

// System maintenance — broadcast to everyone (guests + authenticated)
async function onMaintenanceScheduled(time: string) {
  broadcastPush({
    id: `maintenance-${Date.now()}`,
    title: 'Scheduled Maintenance',
    body: `System will be down for maintenance at ${time}`,
    type: 'warning',
  });
}
```

## Go — Server Example

```go
type Message struct {
    Event string          `json:"event"`
    Data  json.RawMessage `json:"data"`
}

type ClientState struct {
    UserID        string
    Authenticated bool
    Channels      map[string]bool
    Topics        map[string]bool
}

func handleMessage(conn *websocket.Conn, state *ClientState, msg Message) {
    switch msg.Event {

    // ─── Auth ──────────────────────────────────

    case "$auth:login":
        var payload struct{ Token string `json:"token"` }
        json.Unmarshal(msg.Data, &payload)
        user, err := verifyToken(payload.Token)
        if err != nil {
            sendJSON(conn, "$auth:revoked", map[string]string{"reason": "invalid_token"})
            return
        }
        state.UserID = user.ID
        state.Authenticated = true
        sendJSON(conn, "auth.ok", map[string]string{"userId": user.ID})

    case "$auth:logout":
        state.Channels = make(map[string]bool)
        state.Topics = make(map[string]bool)
        state.UserID = ""
        state.Authenticated = false

    // ─── Channels ──────────────────────────────

    case "$channel:join":
        var payload struct{ Channel string `json:"channel"` }
        json.Unmarshal(msg.Data, &payload)
        // Guard: private channels require auth
        if isPrivateChannel(payload.Channel) && !state.Authenticated {
            sendJSON(conn, "error", map[string]string{"message": "auth required"})
            return
        }
        state.Channels[payload.Channel] = true

    case "$channel:leave":
        var payload struct{ Channel string `json:"channel"` }
        json.Unmarshal(msg.Data, &payload)
        delete(state.Channels, payload.Channel)

    // ─── Topics ────────────────────────────────

    case "$topic:subscribe":
        var payload struct{ Topic string `json:"topic"` }
        json.Unmarshal(msg.Data, &payload)
        if isPrivateTopic(payload.Topic) && !state.Authenticated {
            sendJSON(conn, "error", map[string]string{"message": "auth required"})
            return
        }
        state.Topics[payload.Topic] = true

    case "$topic:unsubscribe":
        var payload struct{ Topic string `json:"topic"` }
        json.Unmarshal(msg.Data, &payload)
        delete(state.Topics, payload.Topic)

    // ─── App Events ────────────────────────────

    case "chat.send":
        // broadcast to channel...

    case "ping":
        conn.WriteJSON(Message{Event: "pong"})
    }
}

func sendJSON(conn *websocket.Conn, event string, data interface{}) {
    raw, _ := json.Marshal(data)
    conn.WriteJSON(Message{Event: event, Data: raw})
}

// Revoke auth for a user across all connections
func revokeUser(userID, reason string) {
    for conn, state := range clients {
        if state.UserID == userID {
            sendJSON(conn, "$auth:revoked", map[string]string{"reason": reason})
            state.Channels = make(map[string]bool)
            state.Topics = make(map[string]bool)
            state.UserID = ""
            state.Authenticated = false
        }
    }
}

func isPrivateChannel(ch string) bool {
    return strings.HasPrefix(ch, "private:") || strings.HasPrefix(ch, "user:")
}

func isPrivateTopic(t string) bool {
    return strings.HasPrefix(t, "user:") || strings.HasPrefix(t, "notifications:")
}

// Send push notification to specific user
func sendPushNotification(userID, title, body, notifType string) {
    for conn, state := range clients {
        if state.UserID == userID {
            sendJSON(conn, "notification", map[string]string{
                "id": uuid.NewString(), "title": title, "body": body, "type": notifType,
            })
        }
    }
}
```

## PHP (Laravel + Ratchet/Swoole) — Server Example

```php
// Per-connection state
private array $state = [];
// $state[$resourceId] = [
//     'userId' => null,
//     'authenticated' => false,
//     'channels' => [],
//     'topics' => [],
// ];

public function onOpen(ConnectionInterface $conn): void
{
    $this->state[$conn->resourceId] = [
        'userId' => null,
        'authenticated' => false,
        'channels' => [],
        'topics' => [],
    ];

    $this->send($conn, 'welcome', [
        'authenticated' => false,
        'timestamp' => time(),
    ]);
}

public function onMessage(ConnectionInterface $conn, $msg): void
{
    $data = json_decode($msg, true);
    $event = $data['event'] ?? 'message';
    $payload = $data['data'] ?? [];

    match ($event) {
        // Auth
        '$auth:login' => $this->handleAuthLogin($conn, $payload['token']),
        '$auth:logout' => $this->handleAuthLogout($conn),

        // Channels (with auth guard)
        '$channel:join' => $this->handleChannelJoin($conn, $payload['channel']),
        '$channel:leave' => $this->leaveChannel($conn, $payload['channel']),

        // Topics (with auth guard)
        '$topic:subscribe' => $this->handleTopicSubscribe($conn, $payload['topic']),
        '$topic:unsubscribe' => $this->unsubscribeTopic($conn, $payload['topic']),

        // App events
        'chat.send' => $this->handleChatMessage($conn, $payload),
        'order.create' => $this->handleOrderCreate($conn, $payload),
        'ping' => $conn->send(json_encode(['type' => 'pong'])),
        default => logger()->warning("Unknown event: {$event}"),
    };
}

// ─── Auth ────────────────────────────────────────

public function handleAuthLogin(ConnectionInterface $conn, string $token): void
{
    $user = $this->verifyToken($token);
    if (!$user) {
        $this->send($conn, '$auth:revoked', ['reason' => 'invalid_token']);
        return;
    }

    $this->state[$conn->resourceId]['userId'] = $user->id;
    $this->state[$conn->resourceId]['authenticated'] = true;

    $this->send($conn, 'auth.ok', [
        'userId' => $user->id,
    ]);
}

public function handleAuthLogout(ConnectionInterface $conn): void
{
    $id = $conn->resourceId;
    logger()->info("User {$this->state[$id]['userId']} deauthenticated");

    // Clean up all auth state
    $this->state[$id]['channels'] = [];
    $this->state[$id]['topics'] = [];
    $this->state[$id]['userId'] = null;
    $this->state[$id]['authenticated'] = false;
}

/** Revoke auth — token expired, admin kick, etc. */
public function revokeAuth(ConnectionInterface $conn, string $reason = 'token_expired'): void
{
    $this->send($conn, '$auth:revoked', ['reason' => $reason]);
    $this->handleAuthLogout($conn);
}

/** Revoke by user ID — affects all connections of that user */
public function revokeUser(string $userId, string $reason = 'account_suspended'): void
{
    foreach ($this->connections as $conn) {
        if (($this->state[$conn->resourceId]['userId'] ?? null) === $userId) {
            $this->revokeAuth($conn, $reason);
        }
    }
}

// ─── Channels (with auth guard) ──────────────────

public function handleChannelJoin(ConnectionInterface $conn, string $channel): void
{
    if ($this->isPrivateChannel($channel) && !$this->isAuthenticated($conn)) {
        $this->send($conn, 'error', ['message' => 'Authentication required', 'channel' => $channel]);
        return;
    }
    $this->state[$conn->resourceId]['channels'][] = $channel;
}

// ─── Topics (with auth guard) ────────────────────

public function handleTopicSubscribe(ConnectionInterface $conn, string $topic): void
{
    if ($this->isPrivateTopic($topic) && !$this->isAuthenticated($conn)) {
        $this->send($conn, 'error', ['message' => 'Authentication required', 'topic' => $topic]);
        return;
    }
    $this->state[$conn->resourceId]['topics'][] = $topic;
}

// ─── App Events (auth required) ──────────────────

public function handleOrderCreate(ConnectionInterface $conn, array $payload): void
{
    if (!$this->requireAuth($conn)) return;
    // ... create order logic
}

// ─── Helpers ─────────────────────────────────────

private function send(ConnectionInterface $conn, string $event, array $data): void
{
    $conn->send(json_encode(['event' => $event, 'data' => $data]));
}

private function isAuthenticated(ConnectionInterface $conn): bool
{
    return $this->state[$conn->resourceId]['authenticated'] ?? false;
}

private function requireAuth(ConnectionInterface $conn): bool
{
    if (!$this->isAuthenticated($conn)) {
        $this->send($conn, 'error', ['message' => 'Authentication required']);
        return false;
    }
    return true;
}

private function isPrivateChannel(string $channel): bool
{
    return str_starts_with($channel, 'private:') || str_starts_with($channel, 'user:');
}

private function isPrivateTopic(string $topic): bool
{
    return str_starts_with($topic, 'user:') || str_starts_with($topic, 'notifications:');
}

public function notifyTopic(string $topic, string $event, array $data): void
{
    foreach ($this->connections as $conn) {
        if (in_array($topic, $this->state[$conn->resourceId]['topics'] ?? [])) {
            $this->send($conn, "{$topic}:{$event}", $data);
        }
    }
}

public function sendPushNotification(string $userId, array $notification): void
{
    foreach ($this->connections as $conn) {
        if (($this->state[$conn->resourceId]['userId'] ?? null) === $userId) {
            $this->send($conn, 'notification', $notification);
        }
    }
}
```

## Global Custom Serialization (MessagePack)

When client uses global `serialize`/`deserialize` (e.g., MessagePack), the **server must use the same format**.

### Client

```typescript
import { encode, decode } from '@msgpack/msgpack';

new SharedWebSocket('wss://api.example.com/ws', {
  serialize: (data) => encode(data),
  deserialize: (raw) => decode(raw as ArrayBuffer),
});
```

### Node.js Server (MessagePack)

```typescript
import { WebSocketServer } from 'ws';
import { encode, decode } from '@msgpack/msgpack';

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws) => {
  // Receive: binary → decode
  ws.on('message', (raw: Buffer, isBinary: boolean) => {
    const msg = isBinary
      ? decode(raw)                              // MessagePack binary
      : JSON.parse(raw.toString());              // fallback to JSON

    const { event, data } = msg as { event: string; data: unknown };

    switch (event) {
      case 'chat.send':
        broadcastMsgpack(wss, 'chat.message', {
          userId: getUserId(ws),
          text: (data as any).text,
          timestamp: Date.now(),
        });
        break;

      case 'ping':
        // Respond with msgpack
        ws.send(encode({ type: 'pong' }));
        break;
    }
  });
});

// Send: encode → binary
function sendMsgpack(ws: WebSocket, event: string, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(encode({ event, data }));
  }
}

function broadcastMsgpack(wss: WebSocketServer, event: string, data: unknown) {
  const payload = encode({ event, data });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}
```

### Go Server (MessagePack)

```go
import "github.com/vmihailenco/msgpack/v5"

// Receive
func handleConnection(conn *websocket.Conn) {
    for {
        _, raw, err := conn.ReadMessage()
        if err != nil { break }

        var msg struct {
            Event string      `msgpack:"event"`
            Data  interface{} `msgpack:"data"`
        }
        msgpack.Unmarshal(raw, &msg)
        // handle msg.Event...
    }
}

// Send
func sendMsgpack(conn *websocket.Conn, event string, data interface{}) {
    payload, _ := msgpack.Marshal(map[string]interface{}{
        "event": event,
        "data":  data,
    })
    conn.WriteMessage(websocket.BinaryMessage, payload)
}
```

## Per-Event Serialization (mixed JSON + binary)

When client uses `ws.serializer('event', fn)` for specific events, the global format stays JSON. Only the `data` field of registered events gets custom serialized.

### Client

```typescript
const ws = new SharedWebSocket('wss://api.example.com/ws');
// Global: JSON (default)

// Per-event: file.upload sends raw binary in data field
ws.serializer('file.upload', (data) => data);  // pass ArrayBuffer as-is

// Per-event: trading.order sends Protobuf in data field
ws.serializer('trading.order', (data) => OrderProto.encode(data).finish());
ws.deserializer('trading.tick', (data) => TickProto.decode(data as Uint8Array));
```

**What the server receives:**

```
Regular event (JSON everywhere):
  { "event": "chat.send", "data": { "text": "hello" } }

Per-event serialized (JSON envelope, binary data):
  { "event": "file.upload", "data": <ArrayBuffer> }
  { "event": "trading.order", "data": <Protobuf bytes> }
```

> **Note:** Per-event serialization transforms the `data` field before the global serializer wraps it. If global is JSON, the message is still a JSON object — but the `data` field contains the custom-serialized value. Your server needs to know which events use custom serialization and decode accordingly.

### Node.js Server (mixed)

```typescript
import { WebSocketServer } from 'ws';
import { OrderProto, TickProto } from './proto/messages';

const wss = new WebSocketServer({ port: 8080 });

// Events that use custom serialization
const binaryEvents = new Set(['file.upload', 'trading.order']);
const protoDecoders: Record<string, (buf: Buffer) => unknown> = {
  'trading.order': (buf) => OrderProto.decode(buf),
};

wss.on('connection', (ws) => {
  ws.on('message', (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());
    const { event, data } = msg;

    // Decode per-event data if needed
    let decodedData = data;
    if (protoDecoders[event] && Buffer.isBuffer(data)) {
      decodedData = protoDecoders[event](data);
    }

    switch (event) {
      case 'trading.order':
        processOrder(decodedData);
        // Respond with Protobuf-encoded tick
        sendWithProto(ws, 'trading.tick', latestTick);
        break;

      case 'file.upload':
        // data is raw binary
        saveFile(getUserId(ws), data);
        send(ws, 'file.uploaded', { success: true });
        break;

      default:
        // Regular JSON events
        handleJsonEvent(ws, event, data);
    }
  });
});

// Send event with Protobuf data field
function sendWithProto(ws: WebSocket, event: string, data: unknown) {
  const encoded = TickProto.encode(data).finish();
  ws.send(JSON.stringify({
    event,
    data: Array.from(encoded),  // Protobuf bytes as JSON array
  }));
}

// Send regular JSON event
function send(ws: WebSocket, event: string, data: unknown) {
  ws.send(JSON.stringify({ event, data }));
}
```

### Key difference: Global vs Per-Event

| Aspect | Global Serialization | Per-Event Serialization |
|--------|---------------------|------------------------|
| **What changes** | Entire message wire format | Only `data` field for registered events |
| **Server impact** | Must use same format (msgpack/protobuf) | Only decode specific events differently |
| **Default** | `JSON.stringify` / `JSON.parse` | None (uses global) |
| **Worker** | Edit worker template | Works automatically (main thread) |
| **Use case** | All traffic is binary | Most is JSON, some events are binary |
