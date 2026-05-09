# Changelog

All notable changes to `@gwakko/shared-websocket` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.13.0]

### Added

- **`onReconnectFailed` lifecycle hook** — fires once auto-reconnect
  exhausts `reconnectMaxRetries`. Use it to surface a "Reconnect" UI
  affordance after the library gives up.
- **`ws.reconnect()` API** — manually resets the retry counter and
  forces a fresh connection. Safe to call from any tab; followers route
  the request to the leader through `BroadcastChannel`.
- **React `useSocketReconnect()`** and **Vue `useSocketReconnect()`**
  composables, returning `{ hasFailed, reconnect }`. Drop-in for a
  snackbar/banner that lets the user retry.
- **`extras` argument on `ws.send(event, data, extras?)`** — adds
  top-level fields to the wire envelope without going through middleware
  or custom serializers. Throws if `extras` collides with the reserved
  `eventField`/`dataField` keys, so silent overwrites surface as errors.
  ```ts
  ws.send('group.member_ready',
    { member_id, ready },
    { type: 'event', channel: 'public.group.xxx' },
  );
  // → { type, channel, event, data }
  ```
- **`raw` envelope on event handlers** — handlers now receive
  `(data, raw)` where `raw` is the full deserialized message. Lets
  consumers access top-level fields (`id`, `kind`, `channel`, `type`)
  for protocols where routing happens on a discriminator outside
  `dataField`. The same change flows through `useSocketEvent`,
  `useSocketStream`, and `useSocketCallback` callbacks in both adapters.
  ```ts
  ws.on('msg', (data, raw) => {
    raw.id;    // 4711
    raw.kind;  // 'order.ready_for_pickup'
  });
  ```

### Changed

- **`SocketState` union extended** — adds `'failed'` to distinguish
  "auto-reconnect gave up" from a clean `'closed'`. The library now
  emits `'failed'` (then `'closed'`) instead of going straight to
  `'closed'` when retries are exhausted.

### Deprecated

_Nothing._

### Removed

_Nothing._

### Fixed

_Nothing._

### Security

_Nothing._

### Breaking changes

These changes are runtime-compatible — existing code keeps working — but
two type-level changes can surface during a TypeScript upgrade:

1. **`SocketState` adds a new variant `'failed'`.** Exhaustive
   `switch (state)` blocks without a `default` will require either a new
   `case 'failed':` arm or a default branch.
2. **`EventHandler<T>` signature is now `(data: T, raw?: unknown) => void`.**
   The second argument is optional, so existing `(data) => {...}` handlers
   still type-check and run unchanged. Custom `EventHandler` aliases that
   redeclared the type with only one parameter may need updating.

No public method or option has been removed or renamed.
