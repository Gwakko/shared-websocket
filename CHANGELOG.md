# Changelog

All notable changes to `@gwakko/shared-websocket` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.13.3]

### Fixed

- **Subscriptions now survive leader change.** Previously, when the
  leader tab closed and a follower was promoted, the new leader opened
  a fresh WebSocket but the server had no record of any subscriptions
  — every tab kept its handlers but no events arrived. Same silent
  failure on plain reconnect: only auth-required channels/topics were
  replayed; non-auth ones were lost.

  The new leader now broadcasts a short-window request over
  `BroadcastChannel`; every surviving tab replies with its
  `channels` and `topics`. The leader unions the responses with its
  own state and re-issues `channelJoin` / `topicSubscribe` frames over
  the new connection. Auth-login is still sent first so auth-gated
  joins succeed in FIFO order.

  Behavior change worth flagging: on every reconnect (not just leader
  change) the library now spends ~150ms gathering before the first
  outgoing frame, then re-sends `subscribe` frames the server may have
  already known about. If your server treats duplicate subscribes as
  errors, configure it to dedupe — most don't.

## [0.13.2]

### Changed

- **`auth()` callback failures pause reconnect.** If the configured
  `auth: () => string | Promise<string>` throws or resolves to an empty
  value, the socket goes to `'failed'` instead of either crashing
  unhandled (throw) or silently connecting without a token (empty).
  Same recovery path as `authFailureCloseCodes`: call
  `ws.authenticate(freshToken)` (auto-resumes) or `ws.reconnect()`.

  Behavior change: previously an empty token from `auth()` produced a
  URL without the auth query param, which most servers rejected — and
  the lib then looped reconnecting with the same empty token. The new
  behavior fails fast.

### Docs

- README "Browser Support" — `BroadcastChannel` is required with no
  fallback; iOS Safari < 15.4, SSR, jsdom, and webview caveats.
- `docs/features.md` Stream — explicit `AbortController` recipe for
  `ws.stream()` outside `withSocket`, with leak-vs-clean React example.
- `docs/configuration.md` Logger — table of what level the library
  emits at, so consumers can wire Sentry/alerting safely. The library
  never calls `error` itself.

## [0.13.1]

### Added

- **`authFailureCloseCodes` option** (default `[1008]`) — close codes
  that mean "auth failed, don't retry." On a close with a matching
  code the state goes straight to `'failed'` instead of looping with
  expired credentials. Add `4xxx` codes here if your server uses them.
  ```ts
  new SharedWebSocket(url, { authFailureCloseCodes: [1008, 4001] });
  ```
- **Auto-resume on `ws.authenticate(token)`** — if the leader's socket
  is in `'failed'` (e.g. auth-failure close above), `authenticate()`
  now triggers a reconnect with the fresh creds. Followers publish a
  conditional resume hint so healthy tabs aren't disrupted.

### Fixed

- **Channel/event delimiter ambiguity.** Channel handler keys were
  built as `${name}:${event}`, which collided when channel or event
  names contained `:` (e.g. `channel('chat').on('room:42:msg')` and
  `channel('chat:room:42').on('msg')` resolved to the same key).
  Storage now uses ASCII RECORD SEPARATOR (U+001E) — wire format keeps
  `:` for server compatibility. Incoming events are routed back to
  channel handlers via a refcounted channel-name registry with prefix
  matching, so behavior is preserved without the collision.

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
