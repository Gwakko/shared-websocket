import './utils/disposable';
import { MessageBus } from './MessageBus';
import type { Unsubscribe } from './types';

interface CoordinatorOptions {
  electionTimeout?: number;   // ms to wait for rejection (default 200)
  heartbeatInterval?: number; // ms between heartbeats (default 2000)
  leaderTimeout?: number;     // ms without heartbeat to trigger election (default 5000)
}

export class TabCoordinator implements Disposable {
  private _isLeader = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leaderCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  private disposed = false;

  private onBecomeLeaderFns = new Set<() => void>();
  private onLoseLeadershipFns = new Set<() => void>();
  private cleanups: Unsubscribe[] = [];

  private readonly electionTimeout: number;
  private readonly heartbeatInterval: number;
  private readonly leaderTimeout: number;

  constructor(
    private readonly bus: MessageBus,
    private readonly tabId: string,
    options: CoordinatorOptions = {},
  ) {
    this.electionTimeout = options.electionTimeout ?? 200;
    this.heartbeatInterval = options.heartbeatInterval ?? 2000;
    this.leaderTimeout = options.leaderTimeout ?? 5000;

    // Listen for election requests — reject if we are leader
    this.cleanups.push(
      this.bus.subscribe<{ tabId: string }>('coord:election', () => {
        if (this._isLeader) {
          this.bus.publish('coord:reject', { tabId: this.tabId });
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
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  async elect(): Promise<void> {
    if (this.disposed) return;

    return new Promise<void>((resolve) => {
      let rejected = false;

      const unsub = this.bus.subscribe('coord:reject', () => {
        rejected = true;
        unsub();
        // We are follower — start monitoring leader heartbeat
        this.startLeaderCheck();
        resolve();
      });

      this.bus.publish('coord:election', { tabId: this.tabId });

      setTimeout(() => {
        unsub();
        if (!rejected && !this.disposed) {
          this.becomeLeader();
        }
        resolve();
      }, this.electionTimeout);
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
      if (Date.now() - this.lastHeartbeat > this.leaderTimeout && !this.disposed) {
        this.stopLeaderCheck();
        this.elect();
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
    if (this._isLeader) {
      this.abdicate();
    }
    this.stopHeartbeat();
    this.stopLeaderCheck();
    for (const unsub of this.cleanups) unsub();
    this.cleanups = [];
    this.onBecomeLeaderFns.clear();
    this.onLoseLeadershipFns.clear();
  }
}
