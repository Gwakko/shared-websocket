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
- [File Upload with Progress](#file-upload-with-progress)
- [Runtime Authentication](#runtime-authentication)
  - [Guest → Authenticated flow](#guest--authenticated-flow)
  - [Auth-aware channels and topics](#auth-aware-channels-and-topics)
  - [Server-initiated revocation](#server-initiated-revocation)

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

## File Upload with Progress

WebSocket API has no built-in upload progress. Use **chunked upload** — split file into pieces, send one by one, track progress on each chunk. For large files prefer HTTP upload with `fetch()` + progress events.

### Vanilla

```typescript
interface UploadProgress {
  uploadId: string;
  loaded: number;
  total: number;
  percent: number;
}

async function uploadFile(
  ws: SharedWebSocket,
  file: File,
  onProgress?: (progress: UploadProgress) => void,
): Promise<string> {
  const CHUNK_SIZE = 64 * 1024; // 64KB chunks
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId = crypto.randomUUID();

  // 1. Tell server we're starting
  ws.send('file.upload.start', {
    uploadId,
    name: file.name,
    size: file.size,
    type: file.contentType,
    totalChunks,
  });

  // 2. Send chunks one by one
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);
    const buffer = await chunk.arrayBuffer();

    ws.send('file.upload.chunk', {
      uploadId,
      index: i,
      data: Array.from(new Uint8Array(buffer)), // bytes as JSON array
    });

    onProgress?.({
      uploadId,
      loaded: end,
      total: file.size,
      percent: Math.round((end / file.size) * 100),
    });
  }

  // 3. Tell server upload is complete
  ws.send('file.upload.complete', { uploadId });

  // 4. Wait for server confirmation
  return new Promise((resolve) => {
    ws.once('file.upload.done', (result: { uploadId: string; url: string }) => {
      if (result.uploadId === uploadId) resolve(result.url);
    });
  });
}

// Usage
await withSocket(url, async ({ ws }) => {
  const input = document.querySelector<HTMLInputElement>('#file-input')!;
  const file = input.files![0];

  const url = await uploadFile(ws, file, (progress) => {
    progressBar.style.width = `${progress.percent}%`;
    progressLabel.textContent = `${progress.percent}% (${formatBytes(progress.loaded)}/${formatBytes(progress.total)})`;
  });

  console.log('Uploaded:', url);
});
```

### React

```tsx
function FileUploader() {
  const ws = useSharedWebSocket();
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setProgress(0);

    const url = await uploadFile(ws, file, (p) => setProgress(p.percent));

    setUploading(false);
    console.log('Uploaded:', url);
  }

  return (
    <div>
      <input type="file" onChange={handleUpload} disabled={uploading} />
      {uploading && (
        <div className="progress-bar">
          <div style={{ width: `${progress}%` }} />
          <span>{progress}%</span>
        </div>
      )}
    </div>
  );
}
```

### Vue

```vue
<script setup lang="ts">
const ws = useSharedWebSocket();
const progress = ref(0);
const uploading = ref(false);

async function handleUpload(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;

  uploading.value = true;
  progress.value = 0;

  const url = await uploadFile(ws, file, (p) => {
    progress.value = p.percent;
  });

  uploading.value = false;
  console.log('Uploaded:', url);
}
</script>

<template>
  <input type="file" @change="handleUpload" :disabled="uploading" />
  <div v-if="uploading" class="progress-bar">
    <div :style="{ width: `${progress}%` }" />
    <span>{{ progress }}%</span>
  </div>
</template>
```

### Server (Node.js)

```typescript
const uploads = new Map<string, { chunks: Buffer[]; meta: any }>();

// Inside ws.on('message') handler:
case 'file.upload.start':
  uploads.set(data.uploadId, { chunks: [], meta: data });
  break;

case 'file.upload.chunk':
  const upload = uploads.get(data.uploadId);
  if (upload) {
    upload.chunks[data.index] = Buffer.from(data.data);
  }
  break;

case 'file.upload.complete': {
  const upload = uploads.get(data.uploadId);
  if (upload) {
    const file = Buffer.concat(upload.chunks);
    const url = await saveToStorage(file, upload.meta.name);
    send(ws, 'file.upload.done', { uploadId: data.uploadId, url });
    uploads.delete(data.uploadId);
  }
  break;
}
```

> **When to use HTTP instead:** Files > 10MB, need resume on disconnect, need server-side validation before accepting, CDN upload (S3 presigned URL). WebSocket chunked upload is best for small files (< 5MB) where real-time progress is needed and you're already connected.

## Runtime Authentication

WebSocket is often a **global instance** — connected before knowing if the user is logged in. Runtime auth lets you authenticate/deauthenticate on an existing connection without reconnecting.

### What happens on each action

#### `ws.authenticate(token)` — login

| # | What happens | Scope |
|---|-------------|-------|
| 1 | `isAuthenticated` → `true` | this tab |
| 2 | Token stored in cross-tab sync store | all tabs |
| 3 | Sends `$auth:login` event with token to server | server |
| 4 | Auth state broadcast via BroadcastChannel | all tabs |
| 5 | `onAuthChange(true)` fires | all tabs |
| 6 | React: `useSocketAuth()` re-renders with `isAuthenticated: true` | all tabs |
| 7 | Vue: `useSocketAuth().isAuthenticated` ref updates | all tabs |
| 8 | `useSocketLifecycle({ onAuthChange })` fires | all tabs |
| 9 | Conditionally rendered components (`{isAuthenticated && <Private />}`) mount | all tabs |

#### `ws.deauthenticate()` — logout

| # | What happens | Scope |
|---|-------------|-------|
| 1 | All `{ auth: true }` channels → auto `leave()` (sends `$channel:leave` + cleans local handlers) | server + this tab |
| 2 | All `{ auth: true }` topics → auto `unsubscribe()` (sends `$topic:unsubscribe`) | server + this tab |
| 3 | `isAuthenticated` → `false` | this tab |
| 4 | Sends `$auth:logout` event to server | server |
| 5 | Token removed from cross-tab sync store | all tabs |
| 6 | Auth state broadcast via BroadcastChannel | all tabs |
| 7 | Other tabs: clear their auth channel/topic tracking | all tabs |
| 8 | `onAuthChange(false)` fires | all tabs |
| 9 | React/Vue: `useSocketAuth()` re-renders with `isAuthenticated: false` | all tabs |
| 10 | Conditionally rendered components (`{isAuthenticated && <Private />}`) unmount → `useChannel`/`useTopics` cleanup runs | all tabs |
| 11 | **Public channels, topics, and event listeners keep working** | all tabs |
| 12 | **WebSocket connection stays open** | leader tab |

#### Server sends `$auth:revoked` — forced deauth

| # | What happens | Scope |
|---|-------------|-------|
| 1 | Leader receives event, broadcasts to all tabs via BroadcastChannel | all tabs |
| 2 | Leader: auto `leave()` for auth channels, `unsubscribe()` for auth topics | server |
| 3 | All tabs: clear auth channel/topic tracking | all tabs |
| 4 | `isAuthenticated` → `false` | all tabs |
| 5 | Token removed from sync store | all tabs |
| 6 | `onAuthChange(false)` fires | all tabs |
| 7 | `ws.on('$auth:revoked', handler)` fires — access `reason` field | all tabs |
| 8 | React/Vue components re-render, private components unmount | all tabs |

#### Leader failover / reconnect

| # | What happens | Scope |
|---|-------------|-------|
| 1 | New leader elected, creates WebSocket, connects | new leader |
| 2 | If `isAuthenticated` — re-sends `$auth:login` with stored token | server |
| 3 | Re-sends `$channel:join` for all auth channels | server |
| 4 | Re-sends `$topic:subscribe` for all auth topics | server |
| 5 | **No user code needed — fully automatic** | — |

### What is NOT affected by deauthenticate

These keep working after `deauthenticate()` — the connection stays open:

- `ws.on(event, handler)` — public event listeners
- `ws.send(event, data)` — sending public events
- `ws.channel(name)` — channels without `{ auth: true }`
- `ws.subscribe(topic)` — topics without `{ auth: true }`
- `ws.sync(key, value)` / `ws.onSync()` — cross-tab state sync
- `ws.push(event, config)` — push notifications for public events
- `ws.stream(event)` — async generators for public events
- `ws.request(event, data)` — request/response for public events
- Lifecycle hooks: `onConnect`, `onDisconnect`, `onReconnecting`, `onLeaderChange`
- Tab visibility: `onActive`, `onInactive`, `onVisibilityChange`

### Guest → Authenticated flow

**Vanilla TypeScript**

```typescript
const ws = new SharedWebSocket('wss://api.example.com/ws');
await ws.connect();

// Works immediately — public events
ws.on('announcement', (msg) => console.log(msg));

// User logs in → authenticate on existing connection
async function login(email: string, password: string) {
  const { token } = await fetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }).then(r => r.json());

  ws.authenticate(token);
  // → sends { event: "$auth:login", data: { token } } to server
}

// User logs out → deauthenticate, connection stays open
function logout() {
  ws.deauthenticate();
  // → auto-leaves auth channels/topics
  // → sends { event: "$auth:logout" } to server
  // → public events still work
}

// React to auth changes
ws.onAuthChange((authenticated) => {
  if (!authenticated) {
    window.location.href = '/login';
  }
});
```

**React**

```tsx
import { useSocketAuth, useSocketLifecycle } from '@gwakko/shared-websocket/react';

// Login page
function LoginPage() {
  const { authenticate } = useSocketAuth();

  const handleLogin = async (email: string, password: string) => {
    const { token } = await api.login(email, password);
    authenticate(token); // syncs across all tabs
  };

  return <LoginForm onSubmit={handleLogin} />;
}

// Header with auth-aware UI
function Header() {
  const { isAuthenticated, deauthenticate } = useSocketAuth();

  return (
    <nav>
      {isAuthenticated
        ? <button onClick={deauthenticate}>Logout</button>
        : <Link to="/login">Login</Link>
      }
    </nav>
  );
}

// Conditional rendering — private components unmount on deauth
function App() {
  const { isAuthenticated } = useSocketAuth();

  return (
    <>
      <Header />
      <PublicFeed />
      {isAuthenticated && <PrivateNotifications />}
      {isAuthenticated && <PrivateChat />}
    </>
  );
}

// Lifecycle hook
useSocketLifecycle({
  onAuthChange: (authenticated) => {
    if (!authenticated) navigate('/login');
  },
});
```

**Vue**

```vue
<script setup lang="ts">
import { useSocketAuth, useSocketLifecycle } from '@gwakko/shared-websocket/vue';

const { isAuthenticated, authenticate, deauthenticate } = useSocketAuth();

async function login(email: string, password: string) {
  const { token } = await api.login(email, password);
  authenticate(token);
}

useSocketLifecycle({
  onAuthChange: (authenticated) => {
    if (!authenticated) router.push('/login');
  },
});
</script>

<template>
  <nav>
    <button v-if="isAuthenticated" @click="deauthenticate">Logout</button>
    <router-link v-else to="/login">Login</router-link>
  </nav>

  <PublicFeed />
  <PrivateNotifications v-if="isAuthenticated" />
  <PrivateChat v-if="isAuthenticated" />
</template>
```

### Auth-aware channels and topics

Mark channels and topics with `{ auth: true }` — they auto-cleanup on deauthenticate or server revocation.

**Vanilla TypeScript**

```typescript
const ws = new SharedWebSocket('wss://api.example.com/ws');
await ws.connect();

// After login
ws.authenticate(token);

// Auth-required channel — auto-leaves on deauth
const chat = ws.channel('chat:private_room', { auth: true });
chat.on('message', (msg) => render(msg));
chat.send('message', { text: 'Hello' });

// Auth-required topics — auto-unsubscribe on deauth
ws.subscribe('notifications:orders', { auth: true });
ws.subscribe(`user:${userId}:mentions`, { auth: true });

// Public channel — NOT affected by deauth
const lobby = ws.channel('chat:lobby');
lobby.on('message', (msg) => render(msg));

// On logout: auth channels/topics auto-cleaned, public channel stays
ws.deauthenticate();
// chat → auto-left, topics → auto-unsubscribed
// lobby → still active
```

**React**

```tsx
import { useSocketAuth, useChannel, useTopics } from '@gwakko/shared-websocket/react';

function PrivateChat({ roomId }: { roomId: string }) {
  // Auth-aware channel — auto-leaves on deauth + unmount
  const chat = useChannel(`chat:${roomId}`, { auth: true });

  // Auth-aware topics
  useTopics([`user:${userId}:mentions`], { auth: true });

  return <ChatUI channel={chat} />;
}

// Mount only when authenticated — clean lifecycle
function App() {
  const { isAuthenticated } = useSocketAuth();

  return (
    <>
      {isAuthenticated && <PrivateChat roomId="private_room" />}
      <PublicLobby /> {/* always mounted */}
    </>
  );
}
```

**Vue**

```vue
<script setup lang="ts">
import { useSocketAuth, useChannel, useTopics } from '@gwakko/shared-websocket/vue';

const { isAuthenticated } = useSocketAuth();

// Auth-aware channel
const chat = useChannel('chat:private_room', { auth: true });

// Auth-aware topics
useTopics(['notifications:orders'], { auth: true });
</script>

<template>
  <ChatUI v-if="isAuthenticated" :channel="chat" />
  <PublicLobby />
</template>
```

### Server-initiated revocation

Server sends `$auth:revoked` when token expires, user is kicked, or permissions change. Client auto-cleans all auth subscriptions.

**Server (Node.js)**

```typescript
// Token expired — revoke auth
function onTokenExpired(ws: WebSocket) {
  ws.send(JSON.stringify({
    event: '$auth:revoked',
    data: { reason: 'token_expired' },
  }));
  // Server-side cleanup of channels/topics for this connection
}

// Handle client auth events
case '$auth:login': {
  const { token } = data;
  const user = verifyToken(token);
  if (!user) {
    // Invalid token — immediately revoke
    send(ws, '$auth:revoked', { reason: 'invalid_token' });
    return;
  }
  state.userId = user.id;
  state.authenticated = true;
  console.log(`${user.id} authenticated`);
  break;
}

case '$auth:logout': {
  // Clean up all auth-related state for this connection
  state.channels.clear();
  state.topics.clear();
  state.userId = undefined;
  state.authenticated = false;
  console.log('Client deauthenticated');
  break;
}
```

**Client handling** — automatic, no code needed:

```typescript
// All of this happens automatically when server sends $auth:revoked:
// 1. Auth channels → auto-left
// 2. Auth topics → auto-unsubscribed
// 3. isAuthenticated → false
// 4. onAuthChange callbacks fire
// 5. React/Vue components re-render

// Optional: listen for revocation reason
ws.on('$auth:revoked', (data) => {
  const { reason } = data as { reason: string };
  if (reason === 'token_expired') {
    showToast('Session expired, please log in again');
  }
});
```

### System events for auth

| Event | Direction | When | Payload |
|-------|-----------|------|---------|
| `$auth:login` | Client → Server | `ws.authenticate(token)` | `{ "token": "..." }` |
| `$auth:logout` | Client → Server | `ws.deauthenticate()` | `{}` |
| `$auth:revoked` | Server → Client | Token expired, user kicked | `{ "reason": "..." }` |

> **Note:** These event names are configurable via `events` option: `events: { authLogin: 'auth.login', authLogout: 'auth.logout', authRevoked: 'auth.kicked' }`
