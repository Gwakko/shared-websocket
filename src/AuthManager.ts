import './utils/disposable';
import { MessageBus } from './MessageBus';
import { SubscriptionManager } from './SubscriptionManager';
import { BUS, LIFECYCLE, AUTH_TOKEN_KEY } from './constants';
import type { Channel, EventHandler, FrameKind, FramePayload, Logger, Unsubscribe } from './types';

/** Everything AuthManager needs from its owner, injected to keep it decoupled. */
export interface AuthManagerDeps {
  bus: MessageBus;
  subs: SubscriptionManager;
  /** Shared cross-tab store; the auth token lives under `AUTH_TOKEN_KEY`. */
  syncStore: Map<string, unknown>;
  isLeader: () => boolean;
  /** Current leader socket state, or undefined when this tab holds no socket. */
  socketState: () => string | undefined;
  /** Force a reconnect of the leader socket. */
  reconnect: () => void;
  /** Route an outgoing frame (leader transmits; follower forwards via bus). */
  dispatch: (kind: FrameKind, payload: FramePayload) => void;
  /** Leave a topic subscription (SharedWebSocket.unsubscribe). */
  unsubscribeTopic: (topic: string) => void;
  /** Server event that signals auth was revoked (proto.authRevoked). */
  authRevokedEvent: string;
  /** Token provider for periodic refresh (options.refresh ?? options.auth). */
  refresh?: () => string | Promise<string>;
  /** Refresh interval in ms; disabled when unset or <= 0. */
  refreshInterval?: number;
  log: Logger;
}

/**
 * Owns runtime authentication: login/logout, cross-tab auth-state sync, the
 * leader-only token refresh timer, re-auth on reconnect, server-revocation
 * handling, and the auth-scoped channel/topic sets that auto-leave on logout.
 *
 * Extracted from SharedWebSocket so this cross-cutting concern is one unit.
 * It still leans on the owner for the things it can't own alone (the socket,
 * the dispatch pipeline, topic teardown) via the injected deps.
 */
export class AuthManager implements Disposable {
  private _isAuthenticated = false;
  /** Auth-scoped channels — auto-left on deauth/revocation. */
  private readonly authChannels = new Map<string, Channel>();
  /** Auth-scoped topics — auto-unsubscribed on deauth/revocation. */
  private readonly authTopics = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock time of the last token refresh — drives the catch-up check. */
  private lastRefreshAt = 0;
  /** Guards against overlapping refreshes (interval tick vs. catch-up). */
  private refreshing = false;
  /** True when the refresh loop is not running (not leader / stopped / disposed). */
  private refreshStopped = true;
  private cleanups: Unsubscribe[] = [];

  constructor(private readonly deps: AuthManagerDeps) {
    // Conditional resume — a follower that re-authenticates hints the leader to
    // reconnect IFF its socket had given up (auth-failure close code), so a
    // healthy connection isn't disrupted.
    this.cleanups.push(
      this.deps.bus.subscribe<void>(BUS.AUTH_RESUME, () => {
        if (this.deps.isLeader() && this.deps.socketState() === 'failed') {
          this.deps.log.info('[SharedWS] resume requested after auth — reconnecting failed socket');
          this.deps.reconnect();
        }
      }),
    );

    // Server-initiated auth revocation — tear down auth-scoped subscriptions.
    this.cleanups.push(
      this.deps.subs.on(this.deps.authRevokedEvent, () => {
        if (this.deps.isLeader()) {
          for (const [, ch] of this.authChannels) ch.leave();
          for (const topic of this.authTopics) this.deps.unsubscribeTopic(topic);
        }
        this.authChannels.clear();
        this.authTopics.clear();
        this._isAuthenticated = false;
        this.deps.syncStore.delete(AUTH_TOKEN_KEY);
        this.deps.subs.emit(LIFECYCLE.AUTH, false);
        this.deps.log.warn('[SharedWS] auth revoked by server');
      }),
    );
  }

  get isAuthenticated(): boolean {
    return this._isAuthenticated;
  }

  /** Track an auth-scoped channel so it auto-leaves on deauth/revocation. */
  registerAuthChannel(name: string, ch: Channel): void {
    this.authChannels.set(name, ch);
  }

  unregisterAuthChannel(name: string): void {
    this.authChannels.delete(name);
  }

  registerAuthTopic(topic: string): void {
    this.authTopics.add(topic);
  }

  unregisterAuthTopic(topic: string): void {
    this.authTopics.delete(topic);
  }

  onAuthChange(fn: (authenticated: boolean) => void): Unsubscribe {
    return this.deps.subs.on(LIFECYCLE.AUTH, fn as EventHandler);
  }

  /**
   * Authenticate on the existing connection: sync the token to all tabs and
   * send the auth-login frame. If the leader socket had failed (e.g. expired
   * creds), the fresh token restarts it.
   */
  authenticate(token: string): void {
    this._isAuthenticated = true;
    this.lastRefreshAt = Date.now(); // a fresh token resets refresh staleness
    this.deps.syncStore.set(AUTH_TOKEN_KEY, token);
    this.deps.bus.broadcast(BUS.SYNC, { key: AUTH_TOKEN_KEY, value: token });
    this.deps.bus.broadcast(BUS.LIFECYCLE, { type: 'auth', authenticated: true });
    this.deps.log.info('[SharedWS] authenticated');

    // If the leader's socket gave up, the new creds should restart it.
    // reauthenticate() resends auth-login from syncStore once reconnected.
    if (this.deps.isLeader() && this.deps.socketState() === 'failed') {
      this.deps.reconnect();
      return;
    }

    if (!this.deps.isLeader()) {
      // Followers can't see leader state — hint to reconnect IFF failed.
      this.deps.bus.publish(BUS.AUTH_RESUME, undefined);
    }

    this.deps.dispatch('auth-login', { data: token });
  }

  /**
   * Deauthenticate: auto-leave auth channels/topics, send auth-logout, and
   * sync the cleared state across tabs. The connection stays open for public
   * events.
   */
  deauthenticate(): void {
    for (const [, ch] of this.authChannels) ch.leave();
    this.authChannels.clear();
    for (const topic of this.authTopics) this.deps.unsubscribeTopic(topic);
    this.authTopics.clear();

    this._isAuthenticated = false;
    this.deps.dispatch('auth-logout', {});
    this.deps.syncStore.delete(AUTH_TOKEN_KEY);
    this.deps.bus.broadcast(BUS.SYNC, { key: AUTH_TOKEN_KEY, value: undefined });
    this.deps.bus.broadcast(BUS.LIFECYCLE, { type: 'auth', authenticated: false });
    this.deps.log.info('[SharedWS] deauthenticated');
  }

  /**
   * Apply an auth-state change broadcast over the bus (fired by every tab,
   * including the originator via broadcast self-delivery): update local state,
   * drop auth-scoped subscriptions on logout, and notify `onAuthChange`.
   */
  applyRemoteAuthState(authenticated: boolean | undefined): void {
    this._isAuthenticated = !!authenticated;
    if (!authenticated) {
      this.authChannels.clear();
      this.authTopics.clear();
    }
    this.deps.subs.emit(LIFECYCLE.AUTH, authenticated);
  }

  /** Re-send the auth-login frame from synced state after a fresh connect. */
  reauthenticate(): void {
    if (!this._isAuthenticated) return;
    const token = this.deps.syncStore.get(AUTH_TOKEN_KEY) as string | undefined;
    if (token) {
      this.deps.dispatch('auth-login', { data: token });
      this.deps.log.debug('[SharedWS] re-authenticated after reconnect');
    }
  }

  /**
   * Start the leader-only periodic token refresh. When the timer fires and the
   * connection is authenticated, the new token flows back through
   * `authenticate()` so subscribers stay synced and the socket re-issues
   * auth-login. Idempotent.
   */
  startRefresh(): void {
    if (!this.refreshStopped) return; // already running
    if (!this.canRefresh() || !this.deps.isLeader()) return;
    this.refreshStopped = false;
    this.lastRefreshAt = Date.now();
    this.scheduleRefresh();
  }

  stopRefresh(): void {
    this.refreshStopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Catch up a refresh that a backgrounded leader missed. Browsers throttle (or
   * freeze) timers in hidden tabs, so the periodic refresh can lapse and the
   * token expire. Call this when the tab becomes visible again: if more than an
   * interval has elapsed since the last refresh, refresh immediately. No-op on
   * followers or when refresh isn't configured.
   */
  refreshIfStale(): void {
    if (this.refreshStopped || this.refreshing) return;
    if (!this.deps.isLeader() || !this._isAuthenticated) return;
    const interval = this.deps.refreshInterval;
    if (!this.deps.refresh || !interval || interval <= 0) return;
    if (Date.now() - this.lastRefreshAt >= interval) {
      void this.runRefresh();
    }
  }

  private canRefresh(): boolean {
    const interval = this.deps.refreshInterval;
    return !!this.deps.refresh && !!interval && interval > 0;
  }

  /**
   * Self-rescheduling tick (not setInterval): each run lines up the next from
   * *now*, so a catch-up refresh on re-activation also resets the cadence
   * instead of racing a still-pending interval.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { void this.runRefresh(); }, this.deps.refreshInterval);
  }

  private async runRefresh(): Promise<void> {
    if (this.refreshing) return;
    if (this.deps.isLeader() && this._isAuthenticated && this.deps.refresh) {
      this.refreshing = true;
      try {
        const token = await this.deps.refresh();
        if (token) {
          this.lastRefreshAt = Date.now();
          this.authenticate(token);
        } else {
          this.deps.log.warn('[SharedWS] refresh() returned empty token — skipping');
        }
      } catch (err) {
        this.deps.log.warn('[SharedWS] refresh() failed', err);
      } finally {
        this.refreshing = false;
      }
    }
    // Reschedule unless we were stopped/disposed while awaiting.
    if (!this.refreshStopped) this.scheduleRefresh();
  }

  [Symbol.dispose](): void {
    this.stopRefresh();
    for (const unsub of this.cleanups) unsub();
    this.cleanups = [];
    this.authChannels.clear();
    this.authTopics.clear();
  }
}
