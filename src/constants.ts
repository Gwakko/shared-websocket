/**
 * Centralized internal identifiers and tuning defaults.
 *
 * The string values here are the cross-tab `BroadcastChannel` topic names and
 * the internal `SubscriptionManager` event keys. They are an implementation
 * detail of a single library version — every tab runs the same build — not a
 * wire/server protocol, so the literal values can change freely as long as
 * they stay consistent within a release. Keeping them in one place removes the
 * scatter of magic strings and the risk of an emit/handler typo mismatch.
 */

/** BroadcastChannel name shared by every tab of one SharedWebSocket instance. */
export const MESSAGE_BUS_CHANNEL = 'shared-ws';

// ─── Cross-tab coordination topics (TabCoordinator) ──────────────────────────

export const COORD = {
  /** Candidate announces an election (carries its tabId). */
  ELECTION: 'coord:election',
  /** Current leader rejects a candidate. */
  REJECT: 'coord:reject',
  /** Leader liveness beat. */
  HEARTBEAT: 'coord:heartbeat',
  /** Leader relinquished — followers should elect. */
  ABDICATE: 'coord:abdicate',
  /** Health probe sent to the leader. */
  PING: 'coord:ping',
  /** Forced demotion demanded by an active tab taking over. */
  STEP_DOWN: 'coord:step-down',
} as const;

/** One-shot reply topic for a health ping keyed by replyId. */
export const coordPongReply = (replyId: string): string => `coord:pong:${replyId}`;

// ─── WebSocket fan-out / routing topics (SharedWebSocket, Outbox) ─────────────

export const BUS = {
  /** Incoming server frame fanned out to every tab. */
  MESSAGE: 'ws:message',
  /** Follower → leader outbound dispatch request. */
  DISPATCH: 'ws:dispatch',
  /** Leader → originator ack: drop the buffered entry. */
  DISPATCH_FLUSHED: 'ws:dispatch-flushed',
  /** New leader asks every tab for still-pending dispatches. */
  GATHER_PENDING: 'ws:gather-pending',
  /** New leader asks every tab for its channels/topics. */
  GATHER_SUBS: 'ws:gather-subs',
  /** Cross-tab state sync (no server roundtrip). */
  SYNC: 'ws:sync',
  /** Request/response routed to the leader's socket. */
  REQUEST: 'ws:request',
  /** Follower asks the leader to reconnect. */
  RECONNECT: 'ws:reconnect',
  /** Follower hint to reconnect a failed socket after re-auth. */
  AUTH_RESUME: 'ws:authenticate-resume',
  /** Lifecycle events broadcast to all tabs. */
  LIFECYCLE: 'ws:lifecycle',
} as const;

/** Reply topic for a pending-dispatch gather keyed by replyId. */
export const busPendingReply = (replyId: string): string => `ws:pending:${replyId}`;
/** Reply topic for a subscription gather keyed by replyId. */
export const busSubsReply = (replyId: string): string => `ws:subs:${replyId}`;

// ─── Internal lifecycle event keys (SubscriptionManager) ─────────────────────

export const LIFECYCLE = {
  CONNECT: '$lifecycle:connect',
  DISCONNECT: '$lifecycle:disconnect',
  RECONNECTING: '$lifecycle:reconnecting',
  RECONNECT_FAILED: '$lifecycle:reconnectFailed',
  LEADER: '$lifecycle:leader',
  ERROR: '$lifecycle:error',
  AUTH: '$lifecycle:auth',
  ACTIVE: '$lifecycle:active',
} as const;

/** Sync-store key holding the runtime auth token. */
export const AUTH_TOKEN_KEY = '$auth:token';

// ─── Tuning defaults ─────────────────────────────────────────────────────────

/** TabCoordinator timing defaults (ms). */
export const COORD_DEFAULTS = {
  ELECTION_TIMEOUT: 200,
  HEARTBEAT_INTERVAL: 2000,
  LEADER_TIMEOUT: 5000,
  LEADER_PING_TIMEOUT: 1500,
  /** How often a follower re-checks the leader heartbeat. */
  LEADER_CHECK_INTERVAL: 1000,
} as const;

/** SharedSocket connection defaults. */
export const SOCKET_DEFAULTS = {
  RECONNECT_MAX_DELAY: 30_000,
  HEARTBEAT_INTERVAL: 30_000,
  SEND_BUFFER: 100,
  /** Initial reconnect backoff before exponential growth. */
  BACKOFF_BASE: 1000,
  /** Default "auth failed — stop retrying" close code (PolicyViolation). */
  AUTH_FAILURE_CLOSE_CODE: 1008,
} as const;

/** SharedWebSocket / Outbox defaults. */
export const WS_DEFAULTS = {
  OUTBOUND_BUFFER_SIZE: 100,
  /** Cross-tab subscription-gather window (ms). */
  GATHER_SUBS_TIMEOUT: 150,
  /** Cross-tab pending-dispatch-gather window (ms). */
  GATHER_PENDING_TIMEOUT: 100,
  /** Default request/response timeout (ms). */
  REQUEST_TIMEOUT: 5000,
  /** Default Channel.ready ack timeout (ms). */
  CHANNEL_ACK_TIMEOUT: 5000,
} as const;
