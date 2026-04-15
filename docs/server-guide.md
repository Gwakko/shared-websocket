# Server-Side Implementation Guide

Complete server reference for integrating with Shared WebSocket clients.

[← Back to README](../README.md)

## Table of Contents

- [Message Format](#message-format)
- [System Events](#system-events-sent-by-client-automatically)
- [Node.js (ws) — Complete Server Example](#nodejs-ws--complete-server-example)
- [Go — Server Example](#go--server-example)
- [PHP (Laravel + Ratchet/Swoole) — Server Example](#php-laravel--ratchetswoole--server-example)

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

## Node.js (ws) — Complete Server Example

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

## Go — Server Example

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

## PHP (Laravel + Ratchet/Swoole) — Server Example

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
