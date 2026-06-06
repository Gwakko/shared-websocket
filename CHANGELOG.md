# Changelog

All notable changes to `@gwakko/shared-websocket` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.16.0]

### Internal

- **Test harness.** Added a vitest suite (`test/`) with in-memory
  `BroadcastChannel` and `WebSocket` mocks. Covers leader election, the
  split-brain tie-break, health-verified takeover, the `heartbeatTimeout`
  liveness watchdog, and the leader-local `request()` path. Run with
  `npm test`.

### Added

- **`heartbeatTimeout` — silently-dead socket detection.** The connection
  heartbeat was send-only: it pushed a ping every `heartbeatInterval` but never
  checked for a reply, so a connection dropped without a close frame (sleep,
  Wi-Fi→cellular, captive portal, NAT timeout) stayed `connected` until the OS
  TCP timeout fired `onclose` — minutes, sometimes never. This also meant the
  new leader health check could see a zombie as "connected." Set
  `heartbeatTimeout` (ms) to force-reconnect when no inbound message (server
  data or pong) arrives within the window. Opt-in (default `0`), works in both
  main-thread and worker modes. Requires the server to send periodic data or
  answer the ping.

### Fixed

- **`ws.request()` from the leader tab no longer times out.** `request()`
  routed through `bus.request('ws:request')`, but the responder is registered
  only on the leader and `MessageBus` ignores requests from its own tab — so a
  leader calling `request()` got no answer and always hit the 5s timeout.
  The owning tab now resolves requests locally against its socket.

- **`ws:request` responder leak across leader handover.** The responder was
  registered on promotion but never removed on demotion. A demoted tab kept
  answering with a null socket (throwing), and each re-promotion stacked
  another responder — sending the request to the server multiple times. It's
  now torn down on every leadership loss and re-registered cleanly.

- **Election split-brain on simultaneous candidates.** Two tabs running
  `elect()` at the same instant both saw no rejection and both became leader
  (two sockets). Elections now carry the candidate's tabId and a lower-tabId
  candidate deterministically pre-empts a higher one, so concurrent elections
  converge on a single leader. This also hardens the new active-tab takeover,
  where several tabs can detect a dead leader at once.

## [0.15.0]

### Added

- **Stuck-leader recovery on idle tabs (health-verified takeover).** Browsers
  throttle (and eventually freeze) timers in backgrounded tabs. When the
  *leader* tab was the one backgrounded, its heartbeat slowed/stopped and its
  WebSocket could be silently killed — yet the dead leader still "held"
  leadership, so a normal election kept deferring to it and the connection
  stayed stuck after you switched tabs.

  `TabCoordinator` now verifies *real* leader health via a `BroadcastChannel`
  ping/pong: a leader only answers a ping while its socket is genuinely
  `connected` (wired up by `SharedWebSocket` via `setHealthCheck`). A zombie
  leader stays silent and is forced to step down so an active tab can take
  over. The check fires from two independent triggers:
  - on `visibilitychange` when a tab becomes visible (`verifyLeader()`), and
  - from the follower's heartbeat-staleness timer, which keeps running on any
    tab that *stays* active — covering the case where the current tab was
    never hidden but a different, backgrounded tab held the dead leader. This
    path previously re-elected blindly (and got rejected by the zombie).

  A leader that finds its *own* socket dead on re-activation reconnects in
  place instead of handing off.

### Options

- `leaderPingTimeout` (default `1500` ms) — how long an active tab waits for
  the leader's pong before taking over.
- `recoverOnActivate` (default `true`) — master switch for the active-tab
  verification. Set `false` to rely solely on heartbeat timeout.

## [0.14.6]

### Fixed

- **Duplicate `subscribe` frame on the first connect.** `dispatch()`'s
  follower path buffered *every* frame kind into `pendingOutbound`, the
  local replay buffer drained by `replayPendingDispatches()` on connect.
  But channel/topic/auth frames are also tracked separately
  (`channelRefs`, `topicRefs`, the auth token) and re-sent by
  `resubscribeOnConnect()`. Since `onConnected()` runs both, a channel
  joined before the socket was connected — the common case, `channel()`
  is called at component mount and the socket opens a moment later —
  was sent to the server **twice**: once from `resubscribeOnConnect()`,
  once from `replayPendingDispatches()`.

  Harmless on an idempotent server, but a wasteful duplicate `subscribe`
  (and `topic-subscribe`) on the wire for every channel.

  The fix limits the `pendingOutbound` replay buffer to `event`
  dispatches — the only kind not otherwise re-established on connect.
  Channel / topic / auth frames now flow through `resubscribeOnConnect()`
  alone. Follower→leader routing (`bus.publish('ws:dispatch')`) and
  `event` replay across leader handover are unchanged.

## [0.14.5]

### Fixed

- **Critical: leader-tab handlers now fire for incoming events.**
  `MessageBus.subscribe`'s wrapper rejected any message whose `source`
  matched the local `tabId`, but `MessageBus.broadcast()` deliberately
  self-delivers via `handleMessage(msg)`. The two cancelled out: the
  leader tab broadcasted `ws:message` after receiving a server frame,
  the broadcast was self-delivered, and the wrapper silently dropped
  it. Net effect: **the leader tab's own `ws.on(...)`,
  `useSocketEvent`, `useSocketCallback`, `useSocketStream`,
  `useSocketLifecycle` handlers never fired** for server events,
  lifecycle changes, or `ws.sync` updates the leader originated.

  This was visible immediately in single-tab apps (the leader is the
  only tab; no events ever reached handlers) and partially in
  multi-tab setups (other tabs worked; the leader didn't).

  The fix narrows the self-skip to `type: 'publish'` (fire-and-forget
  to other tabs) so `type: 'broadcast'` (intentionally fan-out-to-all
  including self) reaches local handlers.

  Pre-existing since the first MessageBus commit — affects every
  prior 0.x release.

## [0.14.4]

### Changed

- **Debug logger output updated for the new pipeline.** Previously
  `→ send chat.message {data}` and `← recv chat.message {data}` —
  fine for the legacy two-key envelope but missing the new context:
  `extras`, the actual wire `frame` after `frameBuilder`, and the full
  `raw` envelope on receive.

  New format keeps a human-readable headline (event name / channel /
  topic) and adds a structured detail object:
  ```
  → send subscribe chat:room_42 { payload: {channel:'chat:room_42'}, frame: {...} }
  → send event chat.message      { payload: {...}, frame: {...} }
  ← recv chat.message            { data: {...}, raw: {...} }
  → send auth-login (token redacted)
  ✗ outgoing dropped by middleware event chat.message
  ```

### Fixed

- **Auth tokens no longer appear in debug logs.** `kind: 'auth-login'`
  send lines previously logged `payload.data` (the token) and the
  built wire frame. Both are now suppressed and replaced with
  `(token redacted)`. Worth flagging if you piped debug logs to a
  log aggregator while authentication was happening — historical
  records may contain tokens; rotate any keys captured before this
  release.

## [0.14.3]

### Added

- **`refresh` callback + `refreshTokenInterval`** — proposal #6 knob 3.
  Pre-emptive token refresh for long-running tabs. The library runs a
  leader-only `setInterval` that calls `refresh()` (or falls back to
  `auth()` if `refresh` is unset) and feeds the new token through
  `authenticate()`. Use ~80% of your token TTL as the interval.
  ```ts
  new SharedWebSocket(url, {
    auth: () => fetchInitialToken(),
    refresh: () => fetchNewToken(),
    refreshTokenInterval: 50 * 60_000, // 50 min for a 60-min token
  });
  ```
  If `refresh()` throws, the failure is logged at `warn` and the timer
  keeps running for the next interval — `authFailureCloseCodes` /
  `ws.authenticate(...)` still cover the "we missed the window" case.
- **README "Server Compatibility" section** — proposal #7.1. Quick
  reference table (Pusher / Reverb / Phoenix / ActionCable / custom
  flat-fields / proprietary) with links to fully-worked
  `frameBuilder` samples in `docs/configuration.md`.

### Changed

- **`frameBuilder` return-value contract** — `undefined` now means
  "fall back to the library default for this kind" instead of "drop
  the frame". `null` still drops. Lets users override only the kinds
  that differ from the default without writing exhaustive switches:
  ```ts
  frameBuilder: (kind, p) => {
    if (kind === 'subscribe') return { type: 'subscribe', channel: p.channel };
    return undefined; // everything else uses the default
  }
  ```
  Strictly additive — previously both `null` and `undefined` dropped,
  so any builder that explicitly returned `undefined` to drop a frame
  needs to switch to `null`. (Unlikely in practice — dropping by
  returning nothing is unusual.)

## [0.14.2]

### Added

- **Outbound dispatch buffer with leader-handover replay** — proposal
  #5a. When a follower's send was lost between BroadcastChannel
  receive and the leader's `socket.send` (e.g. the leader tab closed
  mid-handover), the frame previously vanished. Each tab now keeps its
  follower-routed dispatches in a local `pending` map keyed by id. The
  leader broadcasts `ws:dispatch-flushed` after processing; the
  originator drops the entry. On leader promotion, the new leader
  gathers pending entries from every surviving tab and replays them
  on the fresh socket after subscriptions are restored.
- **`outboundBufferSize` option** (default `100`, set to `0` to
  disable). Caps memory; oldest entries drop on overflow.

### Changed

- Replay is **at-least-once**: a leader that dies after `socket.send`
  but before broadcasting `flushed` will cause a duplicate when the
  next leader replays. Make server-side handlers idempotent (e.g.
  dedupe by message id) if duplicate effects would matter. Documented
  in `docs/configuration.md` "Outbound buffer & leader handover".

## [0.14.1]

### Added

- **`Channel.ready: Promise<void>`** — proposal #3. Lets callers await
  the server's subscribe ack before attaching handlers, so messages
  that race with subscribe registration aren't lost and authz failures
  surface as a real rejection instead of "no events ever arrived":
  ```ts
  const ch = ws.channel('rooms:lobby');
  try {
    await ch.ready;
    ch.on('new_msg', renderMsg);
  } catch (err) {
    toast.error(err.message);   // rejected, timed out, or .leave()d first
  }
  ```
- **`events.channelAckMatcher`** + **`events.channelAckTimeout`** —
  configure how `Channel.ready` decides ack/reject for protocols that
  send subscribe replies (Phoenix `phx_reply`, ActionCable
  `confirm_subscription`, etc.). Returns `'ok'` / `'reject'` /
  `'pending'` per incoming frame; matcher exceptions are treated as a
  hard reject. Default timeout 5000 ms.
- **`ChannelAckResult` type** exported from the package root.

### Changed

- **Default `Channel.ready` behavior is non-breaking.** Without
  `channelAckMatcher` configured the promise resolves immediately
  after the subscribe frame is dispatched — fire-and-forget servers
  don't change behavior. Only opting into a matcher makes `ready`
  block on a real ack.

## [0.14.0]

### Added

- **`events.frameBuilder` hook** — full control over the outgoing wire
  shape per `FrameKind`. The default two-key `{ [eventField]:
  <name>, [dataField]: <data> }` envelope only fits a subset of
  servers; Pusher-extended, Reverb, Phoenix, and any custom server with
  more than two top-level fields (`type` discriminator **plus**
  `channel` **plus** `event` **plus** `data`) couldn't be expressed
  before without reaching into `extras` / `serialize` / middleware as
  workarounds. Now they're a single `frameBuilder` function that maps
  semantic frame kinds to whatever shape the server expects:
  ```ts
  events: {
    frameBuilder: (kind, p) => {
      switch (kind) {
        case 'subscribe': return { type: 'subscribe', channel: p.channel };
        case 'event':     return { type: 'event', channel: p.channel, event: p.event, data: p.data };
        // ...
      }
    },
  }
  ```
- **`FrameKind` and `FramePayload` types** are exported from the
  package root for users writing custom builders.
- **Channel-aware events.** `Channel.send` now passes the channel name
  as a structural `FramePayload.channel` field instead of
  string-joining it onto the event name. The default builder still
  produces `${channel}:${event}` on the wire (back-compat); custom
  builders can put the channel in a top-level field.

### Changed

- **Outgoing middleware now runs on the leader for follower-routed
  sends.** Previously middleware was applied on the originating tab
  before publishing to `BroadcastChannel`, but the leader's bus
  subscriber rebuilt the frame from scratch — silently dropping any
  middleware modifications. Frames are now built and middleware runs
  exactly once, on the tab that owns the socket. If you depended on
  the old per-tab behavior (e.g. tab-local context like a per-tab id),
  thread that context through the bus payload.
- **Internal frame pipeline unified.** `send`, `subscribe`,
  `unsubscribe`, `channel().send` / `.leave()`, `authenticate`,
  `deauthenticate`, and the `request()` responder all route through a
  single `dispatch(kind, payload)` → `transmit(kind, payload)`
  pipeline. The follower→leader bus topic is renamed `ws:send` →
  `ws:dispatch` and now carries `{ kind, payload }` instead of
  `{ event, data, extras }`.
- **`request()` now respects `eventField`/`dataField`.** The
  leader-side responder previously sent literal `{ event, data }`
  regardless of the configured field names. It now goes through
  `transmit('event', ...)` like every other outgoing frame.

### Breaking changes

Runtime-compatible at the public-API level: `ws.send`, `Channel.send`,
`subscribe`, `authenticate`, etc. all keep the same signatures and
default wire output. Two edges to flag:

1. **Anything subscribed to the internal `ws:send` BroadcastChannel
   topic** (rare — internal plumbing) won't see traffic any more. Use
   `ws:dispatch` if you really need to observe outgoing frames.
2. **Outgoing middleware that relied on running per-originating-tab**
   now runs on the leader. See "Changed" above.

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
