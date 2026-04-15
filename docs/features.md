# Features

Deep dive into all Shared WebSocket features with examples for Vanilla, React, and Vue.

[← Back to README](../README.md)

## Table of Contents

- [Typed Events](#typed-events)
  - [Type narrowing for untyped events](#type-narrowing-for-untyped-events)
  - [Runtime validation with Zod](#runtime-validation-with-zod)
- [Channels — Private Channels, Chat Rooms, Tenant Notifications](#channels--private-channels-chat-rooms-tenant-notifications)
  - [Server-side channel handling](#server-side-channel-handling)
- [Topics — Server-Side Filtered Subscriptions](#topics--server-side-filtered-subscriptions)
- [Push Notifications](#push-notifications)
  - [Custom Render](#custom-render--you-control-the-display)
  - [Browser Notification API](#browser-notification-api--native-os-notifications)
  - [Critical alerts — show in ALL tabs](#critical-alerts--show-in-all-tabs)
  - [Both — toast in UI + browser notification](#both--toast-in-ui--browser-notification)
- [Tab Sync](#tab-sync)
- [Lifecycle Hooks](#lifecycle-hooks)
- [Stream — Consume Events as Async Iterator](#stream--consume-events-as-async-iterator)
- [Request — Request/Response Through Server](#request--requestresponse-through-server)

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

## Channels — Private Channels, Chat Rooms, Tenant Notifications

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

## Tab Sync

Sync state across tabs via BroadcastChannel with no server roundtrip. See [Getting Started](./getting-started.md) for `withSocket()` examples with tab sync.

```typescript
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
```

## Lifecycle Hooks

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

## Stream — Consume Events as Async Iterator

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

## Request — Request/Response Through Server

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
