# Tab Sync — Cross-Tab State Without WebSocket

Sync state across browser tabs using BroadcastChannel. No WebSocket, no server, zero dependencies.

[← Back to README](../README.md)

## Table of Contents

- [When to Use](#when-to-use)
- [Installation](#installation)
- [Vanilla TypeScript](#vanilla-typescript)
- [React](#react)
- [Vue 3](#vue-3)
- [API Reference](#api-reference)
- [Recipes](#recipes)
  - [Theme switcher](#theme-switcher)
  - [Shopping cart](#shopping-cart)
  - [Form draft auto-save](#form-draft-auto-save)
  - [Auth state across tabs](#auth-state-across-tabs)
  - [Multi-tab logout](#multi-tab-logout)
  - [User preferences](#user-preferences)
  - [Active tab indicator](#active-tab-indicator)

## When to Use

| Scenario | Use |
|----------|-----|
| Sync state between tabs (theme, cart, auth) | `TabSync` (this page) |
| Sync state + real-time server events | `SharedWebSocket.sync()` ([features](./features.md#tab-sync)) |
| Only server events, no tab sync | `SharedWebSocket` without sync |

`TabSync` is standalone — import it without pulling in WebSocket code:

```typescript
import { TabSync } from '@gwakko/shared-websocket/sync';
```

## Installation

```bash
npm install @gwakko/shared-websocket
```

Only import what you need — tree-shaking removes the rest:

```typescript
// Standalone sync (no WebSocket code bundled)
import { TabSync } from '@gwakko/shared-websocket/sync';

// React hooks
import { TabSyncProvider, useTabSync } from '@gwakko/shared-websocket/sync/react';

// Vue composables
import { createTabSyncPlugin, useTabSync } from '@gwakko/shared-websocket/sync/vue';
```

## Vanilla TypeScript

```typescript
import { TabSync } from '@gwakko/shared-websocket/sync';

const sync = new TabSync('my-app');

// ── Set & read ────────────────────────────────────────

sync.set('theme', 'dark');
sync.set('locale', 'en');
sync.set('cart', { items: [1, 2, 3], total: 29.99 });

const theme = sync.get<string>('theme');     // 'dark'
const cart = sync.get<Cart>('cart');          // { items: [...], total: 29.99 }

// ── Listen for changes from ANY tab ───────────────────

const unsub = sync.on<string>('theme', (theme) => {
  document.documentElement.setAttribute('data-theme', theme);
});

// Another tab calls sync.set('theme', 'light') → this callback fires

// ── One-time listener ─────────────────────────────────

sync.once<Cart>('cart', (cart) => {
  console.log('First cart update:', cart);
});

// ── Delete ────────────────────────────────────────────

sync.delete('cart');    // removes + notifies all tabs
sync.has('cart');       // false

// ── Inspect ───────────────────────────────────────────

sync.keys();           // ['theme', 'locale']
sync.size;             // 2

// ── Cleanup ───────────────────────────────────────────

unsub();               // stop listening to 'theme'
sync.clear();          // remove all keys + notify
sync.dispose();        // close BroadcastChannel
```

## React

```tsx
import {
  TabSyncProvider,
  useTabSync,
  useTabSyncValue,
  useTabSyncCallback,
} from '@gwakko/shared-websocket/sync/react';

// ── Provider at app root ──────────────────────────────

function App() {
  return (
    <TabSyncProvider channel="my-app">
      <ThemeSwitcher />
      <CartBadge />
      <DraftEditor />
    </TabSyncProvider>
  );
}

// ── Two-way sync (like useState, but across tabs) ─────

function ThemeSwitcher() {
  const [theme, setTheme] = useTabSync('theme', 'light');

  return (
    <select value={theme} onChange={(e) => setTheme(e.target.value)}>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
      <option value="system">System</option>
    </select>
  );
  // User switches theme in Tab 1 → Tab 2, 3, ... update instantly
}

// ── Two-way sync with side effect callback ────────────

function CartBadge() {
  const [cart, setCart] = useTabSync('cart', { items: [], total: 0 }, (cart) => {
    // Side effect: update document title on every change
    document.title = cart.items.length > 0
      ? `Shop (${cart.items.length})`
      : 'Shop';
  });

  return (
    <div>
      <span>Cart: {cart.items.length} items (${cart.total})</span>
      <button onClick={() => setCart({ items: [], total: 0 })}>Clear</button>
    </div>
  );
}

// ── Read-only — just observe, no setter ───────────────

function ThemeIndicator() {
  const theme = useTabSyncValue<string>('theme');
  return <span>Current: {theme ?? 'not set'}</span>;
}

// ── Fire-and-forget — side effects only ───────────────

function ThemeApplier() {
  useTabSyncCallback<string>('theme', (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
  });
  return null;
}

// ── Form draft synced across tabs ─────────────────────

function DraftEditor() {
  const [draft, setDraft] = useTabSync('email-draft', '');

  return (
    <textarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      placeholder="Start typing — synced across tabs..."
    />
  );
  // Type in Tab 1 → Tab 2 shows the same text in real-time
}
```

## Vue 3

```typescript
// main.ts
import { createApp } from 'vue';
import { createTabSyncPlugin } from '@gwakko/shared-websocket/sync/vue';
import App from './App.vue';

const app = createApp(App);
app.use(createTabSyncPlugin('my-app'));
app.mount('#app');
```

```vue
<!-- ThemeSwitcher.vue — two-way sync -->
<script setup lang="ts">
import { useTabSync } from '@gwakko/shared-websocket/sync/vue';

// Reactive ref — synced across all tabs
const theme = useTabSync('theme', 'light');
// theme.value = 'dark' → all tabs update
</script>

<template>
  <select v-model="theme">
    <option value="light">Light</option>
    <option value="dark">Dark</option>
    <option value="system">System</option>
  </select>
</template>
```

```vue
<!-- CartBadge.vue — two-way sync with callback -->
<script setup lang="ts">
import { useTabSync } from '@gwakko/shared-websocket/sync/vue';

interface Cart {
  items: number[];
  total: number;
}

const cart = useTabSync<Cart>('cart', { items: [], total: 0 }, (cart) => {
  document.title = cart.items.length > 0
    ? `Shop (${cart.items.length})`
    : 'Shop';
});

function clearCart() {
  cart.value = { items: [], total: 0 };
}
</script>

<template>
  <span>Cart: {{ cart.items.length }} items (${{ cart.total }})</span>
  <button @click="clearCart">Clear</button>
</template>
```

```vue
<!-- ThemeApplier.vue — fire-and-forget listener -->
<script setup lang="ts">
import { useTabSyncCallback } from '@gwakko/shared-websocket/sync/vue';

useTabSyncCallback<string>('theme', (theme) => {
  document.documentElement.setAttribute('data-theme', theme);
});
</script>
```

```vue
<!-- DraftEditor.vue — form synced across tabs -->
<script setup lang="ts">
import { useTabSync } from '@gwakko/shared-websocket/sync/vue';

const draft = useTabSync('email-draft', '');
</script>

<template>
  <textarea v-model="draft" placeholder="Start typing — synced across tabs..." />
</template>
```

```vue
<!-- ThemeIndicator.vue — read-only -->
<script setup lang="ts">
import { useTabSyncValue } from '@gwakko/shared-websocket/sync/vue';

const theme = useTabSyncValue<string>('theme');
</script>

<template>
  <span>Current: {{ theme ?? 'not set' }}</span>
</template>
```

## API Reference

### TabSync

| Method | Description |
|--------|-------------|
| `new TabSync(channel?)` | Create instance. Default channel: `"tab-sync"` |
| `set(key, value)` | Set value, broadcast to all tabs, notify local listeners |
| `get<T>(key)` | Get current value from local store |
| `delete(key)` | Delete key, broadcast deletion |
| `has(key)` | Check if key exists |
| `keys()` | List all keys |
| `size` | Number of entries |
| `on(key, fn)` | Listen for changes (returns unsubscribe function) |
| `once(key, fn)` | Listen once, auto-unsubscribe |
| `clear()` | Remove all keys, notify all listeners |
| `dispose()` | Close BroadcastChannel, clear all state |

### React Hooks

| Hook | Returns | Description |
|------|---------|-------------|
| `useTabSync(key, initial, cb?)` | `[T, setter]` | Two-way sync, like `useState` across tabs |
| `useTabSyncValue(key)` | `T \| undefined` | Read-only subscription |
| `useTabSyncCallback(key, cb)` | `void` | Fire-and-forget listener |
| `useTabSyncContext()` | `TabSync` | Direct access to instance |

### Vue Composables

| Composable | Returns | Description |
|------------|---------|-------------|
| `useTabSync(key, initial, cb?)` | `Ref<T>` | Two-way reactive ref across tabs |
| `useTabSyncValue(key)` | `Ref<T \| undefined>` | Read-only ref |
| `useTabSyncCallback(key, cb)` | `void` | Fire-and-forget listener |
| `useTabSyncContext()` | `TabSync` | Direct access to instance |

## Recipes

### Theme switcher

**Vanilla**
```typescript
const sync = new TabSync('my-app');
sync.set('theme', 'dark');
sync.on<string>('theme', (theme) => {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme); // persist for next visit
});
```

**React**
```tsx
const [theme, setTheme] = useTabSync('theme', localStorage.getItem('theme') ?? 'light');
useEffect(() => {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
}, [theme]);
```

**Vue**
```vue
<script setup>
const theme = useTabSync('theme', localStorage.getItem('theme') ?? 'light');
watch(theme, (t) => {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
});
</script>
<template><select v-model="theme">...</select></template>
```

### Shopping cart

**Vanilla**
```typescript
const sync = new TabSync('shop');

// Add item from any tab
function addToCart(productId: string, price: number) {
  const cart = sync.get<Cart>('cart') ?? { items: [], total: 0 };
  cart.items.push(productId);
  cart.total += price;
  sync.set('cart', cart);
}

// Badge updates in all tabs
sync.on<Cart>('cart', (cart) => {
  document.querySelector('.badge')!.textContent = String(cart.items.length);
});
```

**React**
```tsx
const [cart, setCart] = useTabSync('cart', { items: [], total: 0 });

function addToCart(productId: string, price: number) {
  setCart({
    items: [...cart.items, productId],
    total: cart.total + price,
  });
}
// All tabs re-render with updated cart
```

**Vue**
```vue
<script setup>
const cart = useTabSync('cart', { items: [], total: 0 });

function addToCart(productId, price) {
  cart.value = {
    items: [...cart.value.items, productId],
    total: cart.value.total + price,
  };
}
</script>
```

### Form draft auto-save

**Vanilla**
```typescript
const sync = new TabSync('my-app');
const textarea = document.querySelector('textarea')!;

textarea.value = sync.get<string>('draft') ?? '';
textarea.addEventListener('input', () => sync.set('draft', textarea.value));
sync.on<string>('draft', (text) => { textarea.value = text; });
```

**React**
```tsx
const [draft, setDraft] = useTabSync('draft', '');
<textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
```

**Vue**
```vue
<script setup>
const draft = useTabSync('draft', '');
</script>
<template><textarea v-model="draft" /></template>
```

### Auth state across tabs

**Vanilla**
```typescript
const sync = new TabSync('my-app');

function login(token: string, user: User) {
  sync.set('auth', { token, user, loggedIn: true });
}

function logout() {
  sync.set('auth', { token: null, user: null, loggedIn: false });
}

sync.on<AuthState>('auth', (auth) => {
  if (!auth.loggedIn) window.location.href = '/login';
});
```

**React**
```tsx
const [auth, setAuth] = useTabSync('auth', { token: null, user: null, loggedIn: false });

// Login in Tab 1 → all tabs get auth state
function login(token: string, user: User) {
  setAuth({ token, user, loggedIn: true });
}

// Logout from any tab → all tabs redirect
useEffect(() => {
  if (!auth.loggedIn) navigate('/login');
}, [auth.loggedIn]);
```

**Vue**
```vue
<script setup>
const auth = useTabSync('auth', { token: null, user: null, loggedIn: false });

function login(token, user) {
  auth.value = { token, user, loggedIn: true };
}

watch(() => auth.value.loggedIn, (loggedIn) => {
  if (!loggedIn) router.push('/login');
});
</script>
```

### Multi-tab logout

```typescript
// One line — logout from ALL tabs
const sync = new TabSync('my-app');

function logout() {
  localStorage.removeItem('token');
  sync.set('logout', Date.now()); // any value triggers listeners
}

// Every tab listens:
sync.on('logout', () => {
  window.location.href = '/login';
});
```

### User preferences

**React**
```tsx
// Preferences synced across tabs + persisted to localStorage
const [prefs, setPrefs] = useTabSync('prefs', {
  fontSize: 14,
  sidebarOpen: true,
  notifications: true,
  ...JSON.parse(localStorage.getItem('prefs') ?? '{}'),
}, (prefs) => {
  localStorage.setItem('prefs', JSON.stringify(prefs));
});

<Slider value={prefs.fontSize} onChange={(v) => setPrefs({ ...prefs, fontSize: v })} />
```

### Active tab indicator

```typescript
const sync = new TabSync('my-app');
const tabId = crypto.randomUUID();

// Register this tab
sync.set(`tab:${tabId}`, { active: true, url: location.href, timestamp: Date.now() });

// Deregister on close
window.addEventListener('beforeunload', () => sync.delete(`tab:${tabId}`));

// List active tabs
const activeTabs = sync.keys()
  .filter(k => k.startsWith('tab:'))
  .map(k => sync.get(k));
```
