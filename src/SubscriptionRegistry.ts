import './utils/disposable';
import { generateId } from './utils/id';
import { MessageBus } from './MessageBus';
import { BUS, busSubsReply, WS_DEFAULTS } from './constants';
import type { FrameKind, FramePayload, Logger, Unsubscribe } from './types';

/**
 * Tracks this tab's channel and topic subscriptions and replays them onto a
 * freshly connected leader socket.
 *
 * Two roles:
 *  - **Bookkeeping** — a refcount of channel subscriptions (so N `channel()`
 *    handles for the same name share one server-side join) and the set of
 *    subscribed topics. `channelNames()` feeds the incoming-event prefix
 *    routing in SharedWebSocket.
 *  - **Replay** — on leader handover/reconnect, gather the *union* of
 *    channels/topics across every surviving tab and re-send the join /
 *    topic-subscribe frames, so a promoted follower doesn't silently drop
 *    subscriptions any tab still cares about. It also answers other tabs'
 *    gather requests.
 *
 * Extracted from SharedWebSocket so this bookkeeping + cross-tab replay is one
 * cohesive unit. Auth-specific subscription sets (auto-leave on deauth) stay in
 * SharedWebSocket — this registry holds the full set used for routing/replay.
 */
export class SubscriptionRegistry implements Disposable {
  /** Refcount of active channel subscriptions per name. */
  private readonly channelRefs = new Map<string, number>();
  /** All topic subscriptions (auth and non-auth). */
  private readonly topics = new Set<string>();
  private cleanups: Unsubscribe[] = [];

  constructor(
    private readonly bus: MessageBus,
    /** Writes a frame to the live socket — supplied by the owner (FramePipeline). */
    private readonly transmit: (kind: FrameKind, payload: FramePayload) => void,
    private readonly log: Logger,
  ) {
    // Announce this tab's channels/topics when a new leader gathers.
    this.cleanups.push(
      this.bus.subscribe<{ replyId: string }>(BUS.GATHER_SUBS, (req) => {
        this.bus.publish(busSubsReply(req.replyId), {
          channels: [...this.channelRefs.keys()],
          topics: [...this.topics],
        });
      }),
    );
  }

  /** Track a channel subscription (refcounted across multiple handles). */
  addChannel(name: string): void {
    this.channelRefs.set(name, (this.channelRefs.get(name) ?? 0) + 1);
  }

  /** Drop one channel reference; forgets the channel at zero. */
  removeChannel(name: string): void {
    const next = (this.channelRefs.get(name) ?? 1) - 1;
    if (next <= 0) this.channelRefs.delete(name);
    else this.channelRefs.set(name, next);
  }

  addTopic(topic: string): void {
    this.topics.add(topic);
  }

  removeTopic(topic: string): void {
    this.topics.delete(topic);
  }

  /** Channel names currently held by this tab (for incoming-event routing). */
  channelNames(): IterableIterator<string> {
    return this.channelRefs.keys();
  }

  /**
   * Re-establish subscriptions on a freshly connected leader socket: gather the
   * union of channels/topics across all surviving tabs, then transmit a join /
   * topic-subscribe for each. `isValid` aborts if the socket was replaced while
   * we were gathering.
   */
  async replay(isValid: () => boolean = () => true): Promise<void> {
    const { channels, topics } = await this.gather();
    if (!isValid()) return;

    for (const name of channels) {
      this.transmit('subscribe', { channel: name });
    }
    for (const topic of topics) {
      this.transmit('topic-subscribe', { topic });
    }

    if (channels.length || topics.length) {
      this.log.info('[SharedWS] replayed subscriptions', {
        channels: channels.length,
        topics: topics.length,
      });
    }
  }

  /**
   * Best-effort cross-tab gather. Broadcasts a request and collects responses
   * for a short window. Times out gracefully — late responses are dropped. Own
   * subs are seeded so we don't rely on BroadcastChannel echo to self.
   */
  private gather(timeoutMs: number = WS_DEFAULTS.GATHER_SUBS_TIMEOUT): Promise<{ channels: string[]; topics: string[] }> {
    const channels = new Set<string>(this.channelRefs.keys());
    const topics = new Set<string>(this.topics);
    const replyId = generateId();

    return new Promise((resolve) => {
      const unsub = this.bus.subscribe<{ channels: string[]; topics: string[] }>(
        busSubsReply(replyId),
        (msg) => {
          for (const c of msg.channels) channels.add(c);
          for (const t of msg.topics) topics.add(t);
        },
      );

      this.bus.publish(BUS.GATHER_SUBS, { replyId });

      setTimeout(() => {
        unsub();
        resolve({ channels: [...channels], topics: [...topics] });
      }, timeoutMs);
    });
  }

  [Symbol.dispose](): void {
    for (const unsub of this.cleanups) unsub();
    this.cleanups = [];
    this.channelRefs.clear();
    this.topics.clear();
  }
}
