# Getting Started

Quick setup and first steps with Shared WebSocket.

[← Back to README](../README.md)

## Table of Contents

- [Installation](#installation)
  - [From npm](#from-npm)
  - [From GitHub](#from-github-latest-source)
  - [Manual](#manual-copy-into-your-project)
  - [Build from source](#build-from-source)
- [Usage — Vanilla TypeScript](#usage--vanilla-typescript)
  - [Scoped Lifecycle — withSocket()](#scoped-lifecycle--withsocket)
- [Usage — React](#usage--react)
- [Usage — Vue 3](#usage--vue-3)
- [Runtime Authentication](#runtime-authentication)

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

## Runtime Authentication

WebSocket connects as a global instance (works for guests). Authenticate and deauthenticate at runtime on the existing connection — no reconnect needed.

### Vanilla TypeScript

```typescript
import { SharedWebSocket } from '@gwakko/shared-websocket';

const ws = new SharedWebSocket('wss://api.example.com/ws');
await ws.connect();

// ── Guest phase — public events work immediately ──────────

ws.on('announcement', (msg) => showBanner(msg));
ws.on('system.status', (status) => updateStatusBar(status));

// ── Login — authenticate on existing connection ───────────

async function login(email: string, password: string) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const { token } = await res.json();

  ws.authenticate(token);
  // Sends: { event: "$auth:login", data: { token } }
  // State synced to all tabs via BroadcastChannel
}

// ── Authenticated phase — private resources ───────────────

// Auth-aware channel — auto-leaves when deauthenticated
const inbox = ws.channel(`user:${userId}:inbox`, { auth: true });
inbox.on('message', (msg) => renderMessage(msg));
inbox.send('read', { messageId: '123' });

// Auth-aware topics — auto-unsubscribe on deauth
ws.subscribe('notifications:orders', { auth: true });
ws.subscribe(`user:${userId}:mentions`, { auth: true });

// Public channel — NOT affected by deauth
const lobby = ws.channel('chat:lobby');
lobby.on('message', (msg) => renderLobbyMessage(msg));

// ── Logout — connection stays open ────────────────────────

function logout() {
  ws.deauthenticate();
  // 1. Auto-leaves: user:${userId}:inbox (auth channel)
  // 2. Auto-unsubscribes: notifications:orders, user:${userId}:mentions
  // 3. Sends: { event: "$auth:logout", data: {} }
  // 4. Public events + lobby channel keep working
}

// ── React to auth changes (including server revocation) ───

ws.onAuthChange((authenticated) => {
  if (authenticated) {
    showUI('dashboard');
  } else {
    showUI('login');
    showToast('You have been logged out');
  }
});

// Listen for revocation reason
ws.on('$auth:revoked', (data) => {
  const { reason } = data as { reason: string };
  if (reason === 'token_expired') {
    showToast('Session expired — please log in again');
  } else if (reason === 'account_suspended') {
    showToast('Your account has been suspended');
  }
});

// Check auth state anywhere
console.log(ws.isAuthenticated); // true / false
```

### React

```tsx
import {
  SharedWebSocketProvider,
  useAuth,
  useSocketEvent,
  useSocketLifecycle,
  useChannel,
  useTopics,
} from '@gwakko/shared-websocket/react';

// ── App root — WebSocket connects once ────────────────────

function App() {
  return (
    <SharedWebSocketProvider
      url="wss://api.example.com/ws"
      options={{ debug: true }}
    >
      <Layout />
    </SharedWebSocketProvider>
  );
}

// ── Layout — auth-aware routing ───────────────────────────

function Layout() {
  const { isAuthenticated } = useAuth();

  // Redirect on deauth / server revocation
  useSocketLifecycle({
    onAuthChange: (auth) => {
      if (!auth) navigate('/login');
    },
  });

  return (
    <>
      <Header />
      {/* Public — always rendered */}
      <Announcements />
      {/* Private — unmounts on deauth, auto-cleans channels/topics */}
      {isAuthenticated && <Dashboard />}
      {isAuthenticated && <PrivateInbox />}
    </>
  );
}

// ── Header — login/logout UI ──────────────────────────────

function Header() {
  const { isAuthenticated, authenticate, deauthenticate } = useAuth();

  const handleLogin = async () => {
    const { token } = await api.login('user@test.com', 'password');
    authenticate(token); // → all tabs become authenticated
  };

  return (
    <nav>
      <h1>MyApp</h1>
      {isAuthenticated ? (
        <button onClick={deauthenticate}>Logout</button>
      ) : (
        <button onClick={handleLogin}>Login</button>
      )}
    </nav>
  );
}

// ── Public component — works for guests ───────────────────

function Announcements() {
  const announcement = useSocketEvent<{ text: string }>('announcement');
  return announcement ? <div className="banner">{announcement.text}</div> : null;
}

// ── Private component — auth-aware channel + topics ───────

function PrivateInbox() {
  // Channel with { auth: true } → auto-leaves on deauth or unmount
  const inbox = useChannel('user:inbox', { auth: true });

  // Topics with { auth: true } → auto-unsubscribe on deauth or unmount
  useTopics(['notifications:orders', 'notifications:payments'], { auth: true });

  const message = useSocketEvent<{ text: string }>('user:inbox:message');
  const notification = useSocketEvent<{ title: string }>('notifications:orders:new');

  return (
    <div>
      {message && <p>Inbox: {message.text}</p>}
      {notification && <p>Order: {notification.title}</p>}
    </div>
  );
}
```

### Vue 3

```typescript
// main.ts — WebSocket connects once at app startup
import { createApp } from 'vue';
import { createSharedWebSocketPlugin } from '@gwakko/shared-websocket/vue';
import App from './App.vue';

const app = createApp(App);
app.use(createSharedWebSocketPlugin('wss://api.example.com/ws', {
  debug: true,
}));
app.mount('#app');
```

```vue
<!-- Layout.vue — auth-aware routing -->
<script setup lang="ts">
import {
  useAuth,
  useSocketLifecycle,
} from '@gwakko/shared-websocket/vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const { isAuthenticated, authenticate, deauthenticate } = useAuth();

async function login() {
  const { token } = await api.login('user@test.com', 'password');
  authenticate(token); // → all tabs become authenticated
}

useSocketLifecycle({
  onAuthChange: (auth) => {
    if (!auth) router.push('/login');
  },
});
</script>

<template>
  <nav>
    <h1>MyApp</h1>
    <button v-if="isAuthenticated" @click="deauthenticate">Logout</button>
    <button v-else @click="login">Login</button>
  </nav>

  <!-- Public — always rendered -->
  <Announcements />

  <!-- Private — unmounts on deauth, auto-cleans channels/topics -->
  <Dashboard v-if="isAuthenticated" />
  <PrivateInbox v-if="isAuthenticated" />
</template>
```

```vue
<!-- Announcements.vue — public, works for guests -->
<script setup lang="ts">
import { useSocketEvent } from '@gwakko/shared-websocket/vue';

const announcement = useSocketEvent<{ text: string }>('announcement');
</script>

<template>
  <div v-if="announcement" class="banner">{{ announcement.text }}</div>
</template>
```

```vue
<!-- PrivateInbox.vue — auth-aware channel + topics -->
<script setup lang="ts">
import {
  useChannel,
  useTopics,
  useSocketEvent,
} from '@gwakko/shared-websocket/vue';

// Channel with { auth: true } → auto-leaves on deauth or unmount
const inbox = useChannel('user:inbox', { auth: true });

// Topics with { auth: true } → auto-unsubscribe on deauth or unmount
useTopics(['notifications:orders', 'notifications:payments'], { auth: true });

const message = useSocketEvent<{ text: string }>('user:inbox:message');
const notification = useSocketEvent<{ title: string }>('notifications:orders:new');
</script>

<template>
  <div>
    <p v-if="message">Inbox: {{ message.text }}</p>
    <p v-if="notification">Order: {{ notification.title }}</p>
  </div>
</template>
```
