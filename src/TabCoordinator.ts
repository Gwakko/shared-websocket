import './utils/disposable';
import { MessageBus } from './MessageBus';
import { generateId } from './utils/id';
import type { Unsubscribe } from './types';

interface CoordinatorOptions {
  electionTimeout?: number;   // ms to wait for rejection (default 200)
  heartbeatInterval?: number; // ms between heartbeats (default 2000)
  leaderTimeout?: number;     // ms without heartbeat to trigger election (default 5000)
  leaderPingTimeout?: number; // ms to wait for a leader pong on active-tab verify (default 1500)
}

export class TabCoordinator implements Disposable {
  private _isLeader = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leaderCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  private disposed = false;

  private onBecomeLeaderFns = new Set<() => void>();
  private onLoseLeadershipFns = new Set<() => void>();
  private onLeaderUnhealthyFns = new Set<() => void>();
  private cleanups: Unsubscribe[] = [];

  /**
   * Optional predicate supplied by the owner that reports whether THIS tab's
   * leader socket is actually alive. A backgrounded leader whose socket has
   * silently died still has `_isLeader === true`, so without this check an
   * election would keep deferring to a zombie. When set, a leader only
   * answers health pings (and passes self-verification) while it returns true.
   */
  private healthCheck: (() => boolean) | null = null;
  /** Re-entrancy guard so rapid visibility toggles don't stack verifications. */
  private verifying = false;
  /**
   * Set while an election is in flight. Lets a concurrent election from a
   * tab with a lower tabId pre-empt this one (deterministic tie-break) so two
   * tabs electing at the same instant can't both become leader (split-brain).
   * Calling it makes this tab yield and become a follower.
   */
  private electionAbort: (() => void) | null = null;

  private readonly electionTimeout: number;
  private readonly heartbeatInterval: number;
  private readonly leaderTimeout: number;
  private readonly leaderPingTimeout: number;

  constructor(
    private readonly bus: MessageBus,
    private readonly tabId: string,
    options: CoordinatorOptions = {},
  ) {
    this.electionTimeout = options.electionTimeout ?? 200;
    this.heartbeatInterval = options.heartbeatInterval ?? 2000;
    this.leaderTimeout = options.leaderTimeout ?? 5000;
    this.leaderPingTimeout = options.leaderPingTimeout ?? 1500;

    // Listen for election requests. If we're already leader, reject so the
    // candidate backs off. If we're mid-election ourselves, the candidate
    // with the smaller tabId wins and we yield — a deterministic tie-break
    // that prevents two simultaneous electors from both becoming leader.
    this.cleanups.push(
      this.bus.subscribe<{ tabId: string }>('coord:election', (msg) => {
        if (this._isLeader) {
          this.bus.publish('coord:reject', { tabId: this.tabId });
        } else if (this.electionAbort && msg.tabId < this.tabId) {
          this.electionAbort();
        }
      }),
    );

    // Listen for heartbeats
    this.cleanups.push(
      this.bus.subscribe<{ tabId: string }>('coord:heartbeat', () => {
        this.lastHeartbeat = Date.now();
      }),
    );

    // Listen for abdication
    this.cleanups.push(
      this.bus.subscribe('coord:abdicate', () => {
        if (!this._isLeader && !this.disposed) {
          this.elect();
        }
      }),
    );

    // Answer health pings — but ONLY while we are a leader whose socket is
    // actually alive. A zombie leader (timer-throttled tab, dead socket)
    // stays silent so the asking tab knows to take over.
    this.cleanups.push(
      this.bus.subscribe<{ replyId: string }>('coord:ping', (req) => {
        if (this._isLeader && !this.disposed && (this.healthCheck?.() ?? true)) {
          this.bus.publish(`coord:pong:${req.replyId}`, { tabId: this.tabId });
        }
      }),
    );

    // Forced step-down — another tab found us unresponsive and is taking
    // over. Demote silently: the demanding tab runs the election itself, so
    // we must NOT publish `coord:abdicate` (that would make every follower
    // elect at once and risk split-brain).
    this.cleanups.push(
      this.bus.subscribe('coord:step-down', () => {
        if (this._isLeader && !this.disposed) {
          this._isLeader = false;
          this.stopHeartbeat();
          for (const fn of this.onLoseLeadershipFns) fn();
        }
      }),
    );
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  async elect(): Promise<void> {
    if (this.disposed) return;

    return new Promise<void>((resolve) => {
      let settled = false;

      // `won` true → become leader; false → yield and monitor as follower.
      const finish = (won: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        this.electionAbort = null;
        if (this.disposed) {
          resolve();
          return;
        }
        if (won) this.becomeLeader();
        else this.startLeaderCheck();
        resolve();
      };

      // A live leader rejected us, OR a lower-tabId concurrent candidate
      // pre-empted us — either way we step back and become a follower.
      const unsub = this.bus.subscribe('coord:reject', () => finish(false));
      this.electionAbort = () => finish(false);

      this.bus.publish('coord:election', { tabId: this.tabId });

      const timer = setTimeout(() => finish(true), this.electionTimeout);
    });
  }

  abdicate(): void {
    if (!this._isLeader) return;
    this._isLeader = false;
    this.stopHeartbeat();
    this.bus.publish('coord:abdicate', { tabId: this.tabId });
    for (const fn of this.onLoseLeadershipFns) fn();
  }

  onBecomeLeader(fn: () => void): Unsubscribe {
    this.onBecomeLeaderFns.add(fn);
    return () => this.onBecomeLeaderFns.delete(fn);
  }

  onLoseLeadership(fn: () => void): Unsubscribe {
    this.onLoseLeadershipFns.add(fn);
    return () => this.onLoseLeadershipFns.delete(fn);
  }

  /**
   * Fired when a self-verification finds THIS tab is leader but its socket
   * is unhealthy (per `setHealthCheck`). The owner should reconnect.
   */
  onLeaderUnhealthy(fn: () => void): Unsubscribe {
    this.onLeaderUnhealthyFns.add(fn);
    return () => this.onLeaderUnhealthyFns.delete(fn);
  }

  /** Supply a predicate reporting whether this tab's leader socket is alive. */
  setHealthCheck(fn: () => boolean): void {
    this.healthCheck = fn;
  }

  /**
   * Verify the active leader is alive and re-elect if it isn't. Call this
   * when a tab becomes visible again after being idle: browser timer
   * throttling can leave a backgrounded leader with a dead socket while its
   * last heartbeat still looks recent enough that no follower would elect.
   *
   * - Leader tab → checks its own socket health; if unhealthy, fires
   *   `onLeaderUnhealthy` so the owner can reconnect.
   * - Follower tab → pings the leader and waits up to `leaderPingTimeout`.
   *   If no healthy leader answers, forces a step-down and runs a fresh
   *   election so this (active) tab can take over the connection.
   */
  async verifyLeader(): Promise<void> {
    if (this.disposed || this.verifying) return;
    this.verifying = true;
    try {
      if (this._isLeader) {
        if (this.healthCheck && !this.healthCheck()) {
          for (const fn of this.onLeaderUnhealthyFns) fn();
        }
        return;
      }
      await this.takeOverIfLeaderDead();
    } finally {
      this.verifying = false;
    }
  }

  /**
   * Follower-only: ping the current leader and take over the connection if no
   * healthy leader answers. Shared by `verifyLeader()` (active-tab path) and
   * the heartbeat-staleness check (covers the case where THIS tab stays active
   * the whole time while a backgrounded leader's socket silently dies — there
   * is no visibility change to trigger `verifyLeader`, but the leader-check
   * timer keeps running and routes here).
   */
  private async takeOverIfLeaderDead(): Promise<void> {
    if (this.disposed || this._isLeader) return;

    const alive = await this.pingLeader();
    if (this.disposed || this._isLeader) return;
    if (alive) {
      // Leader is healthy (its heartbeat may just have been throttled) —
      // treat the pong as a fresh heartbeat so we don't immediately retry.
      this.lastHeartbeat = Date.now();
      return;
    }

    // No healthy leader answered — demand step-down, then take over. The
    // step-down message is delivered before our election frame on the same
    // ordered channel, so the old leader won't reject the election.
    this.bus.publish('coord:step-down', { tabId: this.tabId });
    this.stopLeaderCheck();
    await this.elect();
  }

  /** Ping the current leader; resolve true if a healthy leader ponged in time. */
  private pingLeader(): Promise<boolean> {
    const replyId = generateId();
    return new Promise<boolean>((resolve) => {
      let answered = false;
      const unsub = this.bus.subscribe(`coord:pong:${replyId}`, () => {
        if (answered) return;
        answered = true;
        unsub();
        resolve(true);
      });
      this.bus.publish('coord:ping', { replyId });
      setTimeout(() => {
        unsub();
        if (!answered) resolve(false);
      }, this.leaderPingTimeout);
    });
  }

  private becomeLeader(): void {
    this._isLeader = true;
    this.stopLeaderCheck();
    this.startHeartbeat();
    for (const fn of this.onBecomeLeaderFns) fn();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.bus.publish('coord:heartbeat', { tabId: this.tabId });
    }, this.heartbeatInterval);
    // Send immediately
    this.bus.publish('coord:heartbeat', { tabId: this.tabId });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startLeaderCheck(): void {
    this.stopLeaderCheck();
    this.lastHeartbeat = Date.now();
    this.leaderCheckTimer = setInterval(() => {
      if (this.disposed || this.verifying) return;
      if (Date.now() - this.lastHeartbeat > this.leaderTimeout) {
        // Heartbeat lapsed. Don't blindly elect — a zombie leader (alive tab,
        // dead socket) would still reject the election and keep the connection
        // stuck. Ping for real health first; take over only if nobody healthy
        // answers. `verifying` guards against overlapping pings each tick.
        this.verifying = true;
        void this.takeOverIfLeaderDead().finally(() => {
          this.verifying = false;
        });
      }
    }, 1000);
  }

  private stopLeaderCheck(): void {
    if (this.leaderCheckTimer) {
      clearInterval(this.leaderCheckTimer);
      this.leaderCheckTimer = null;
    }
  }

  [Symbol.dispose](): void {
    this.disposed = true;
    this.electionAbort = null;
    if (this._isLeader) {
      this.abdicate();
    }
    this.stopHeartbeat();
    this.stopLeaderCheck();
    for (const unsub of this.cleanups) unsub();
    this.cleanups = [];
    this.onBecomeLeaderFns.clear();
    this.onLoseLeadershipFns.clear();
    this.onLeaderUnhealthyFns.clear();
  }
}
