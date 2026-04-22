# API Reference

Complete reference for all methods, options, hooks, and composables.

[← Back to README](../README.md)

## Table of Contents

- [SharedWebSocket](#sharedwebsocket)
- [withSocket()](#withsocket)
- [Options](#options)
- [Properties](#properties)
- [Authentication](#authentication)
- [React Hooks](#react-hooks-react-19-useeffectevent-for-stable-refs)
- [Vue Composables](#vue-composables)

## SharedWebSocket

| Method | Description |
|--------|-------------|
| `connect()` | Start leader election and connect |
| `on(event, handler)` | Subscribe to server events (all tabs) |
| `once(event, handler)` | Subscribe once |
| `off(event, handler?)` | Unsubscribe |
| `stream(event, signal?)` | AsyncGenerator for consuming events |
| `send(event, data)` | Send to server (routed through leader) |
| `request(event, data, timeout?)` | Request/response via server |
| `sync(key, value)` | Sync state across tabs (no server) |
| `getSync(key)` | Get synced value |
| `onSync(key, fn)` | Listen for sync changes |
| `authenticate(token)` | Runtime auth on existing connection |
| `deauthenticate()` | Logout, auto-leave auth channels/topics |
| `onAuthChange(fn)` | Listen for auth state changes |
| `disconnect()` | Close connection and cleanup |
| `[Symbol.dispose]()` | Cleanup (also called by `disconnect`) |

## withSocket()

| Signature | Description |
|-----------|-------------|
| `withSocket(url, callback)` | Scoped lifecycle, auto-dispose |
| `withSocket(url, options, callback)` | With auth, signal, etc. |

Callback receives `{ ws, signal }` — destructure what you need. Signal aborts when scope exits.

## Options

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

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | Connection status |
| `tabRole` | `'leader' \| 'follower'` | Current tab's role |
| `isActive` | `boolean` | Whether this tab is visible/focused |
| `isAuthenticated` | `boolean` | Whether user is authenticated via runtime auth |

## Authentication

### Connect-time auth (URL parameter)

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

### Runtime auth (on existing connection)

Authenticate/deauthenticate without reconnecting. Auth state syncs across all tabs.

| Method | Description |
|--------|-------------|
| `authenticate(token)` | Send `$auth:login` to server, set `isAuthenticated = true` |
| `deauthenticate()` | Auto-leave auth channels/topics, send `$auth:logout` |
| `onAuthChange(fn)` | Called on authenticate, deauthenticate, or server revocation |
| `channel(name, { auth: true })` | Channel that auto-leaves on deauth |
| `subscribe(topic, { auth: true })` | Topic that auto-unsubscribes on deauth |

See [Runtime Authentication](./features.md#runtime-authentication) for full examples.

## React Hooks (React 19, `useEffectEvent` for stable refs)

All hooks use context internally — no need to pass `ws`. Every hook accepts an **optional callback** for custom handling.

| Hook | Without callback | With callback |
|------|-----------------|---------------|
| `useSharedWebSocket()` | `SharedWebSocket` | — |
| `useSocketEvent<T>(event, cb?)` | Returns `T \| undefined` | `cb(data)` on each event |
| `useSocketStream<T>(event, cb?)` | Returns `T[]` (accumulated) | `cb(data)` — manage your own state |
| `useSocketSync<T>(key, init, cb?)` | Returns `[T, setter]` | `cb(value)` — side effects on sync |
| `useSocketCallback<T>(event, cb)` | — | Fire-and-forget (no state) |
| `useSocketAuth()` | `{ isAuthenticated, authenticate, deauthenticate }` | — |
| `useSocketStatus()` | `{ connected, tabRole, isAuthenticated }` | — |
| `useSocketLifecycle(handlers)` | — | onConnect, onDisconnect, onReconnecting, onLeaderChange, onError, onAuthChange |
| `useChannel(name, opts?)` | `Channel` handle | Auto-join/leave, `{ auth: true }` for auth-aware |

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

## Vue Composables

All composables accept an **optional callback** — same pattern as React hooks.

| Composable | Without callback | With callback |
|-----------|-----------------|---------------|
| `useSharedWebSocket()` | `SharedWebSocket` | — |
| `useSocketEvent<T>(event, cb?)` | `Ref<T>` | `cb(data)` on each event |
| `useSocketStream<T>(event, cb?)` | `Ref<T[]>` | `cb(data)` — manage your own ref |
| `useSocketSync<T>(key, init, cb?)` | `Ref<T>` (two-way) | `cb(value)` — side effects on sync |
| `useSocketCallback<T>(event, cb)` | — | Fire-and-forget |
| `useSocketAuth()` | `{ isAuthenticated, authenticate, deauthenticate }` | — |
| `useSocketStatus()` | `{ connected, tabRole, isAuthenticated }` | — |
