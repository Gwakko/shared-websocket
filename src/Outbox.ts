import './utils/disposable';
import { generateId } from './utils/id';
import { MessageBus } from './MessageBus';
import type { FrameKind, FramePayload, Logger, Unsubscribe } from './types';

interface OutboxEntry {
  id: string;
  kind: FrameKind;
  payload: FramePayload;
  enqueuedAt: number;
}

/** Subset of an OutboxEntry shared across tabs (no local-only timestamp). */
type ReplayEntry = Pick<OutboxEntry, 'id' | 'kind' | 'payload'>;

/**
 * At-least-once outbox for follower-originated dispatches.
 *
 * When a follower calls `send()`, the frame is published over the bus for the
 * leader to write. If the leader dies between receiving the dispatch and
 * writing it to the socket, the frame would be lost — so each `event` dispatch
 * is buffered locally with a unique id. The leader broadcasts `ws:dispatch-
 * flushed` once it processes the dispatch and the originator drops the entry.
 * On leader change, the new leader gathers still-pending entries from every
 * surviving tab and replays them over the fresh socket.
 *
 * Extracted from SharedWebSocket so the buffer + gather/replay protocol is one
 * cohesive unit. (Only `event` kinds are buffered — channel/topic/auth frames
 * are re-established separately by resubscribe-on-connect.)
 */
export class Outbox implements Disposable {
  private readonly pending = new Map<string, OutboxEntry>();
  private cleanups: Unsubscribe[] = [];

  constructor(
    private readonly bus: MessageBus,
    private readonly maxSize: number,
    /** Writes a frame to the live socket — supplied by the owner (FramePipeline). */
    private readonly transmit: (kind: FrameKind, payload: FramePayload) => void,
    private readonly log: Logger,
  ) {
    // Originator drops its entry once the leader confirms the dispatch (or, on
    // leader change, the new leader confirms replay).
    this.cleanups.push(
      this.bus.subscribe<{ id: string }>('ws:dispatch-flushed', (msg) => {
        this.pending.delete(msg.id);
      }),
    );

    // A new leader asks every tab to announce its still-pending dispatches.
    this.cleanups.push(
      this.bus.subscribe<{ replyId: string }>('ws:gather-pending', (req) => {
        if (this.pending.size === 0) return;
        this.bus.publish(`ws:pending:${req.replyId}`, {
          entries: [...this.pending.values()],
        });
      }),
    );
  }

  get size(): number {
    return this.pending.size;
  }

  /**
   * Route a follower dispatch to the leader. Buffers `event` kinds locally for
   * replay across handover, then publishes for the leader's socket. Channel /
   * topic / auth frames are not buffered — they're re-sent by
   * resubscribe-on-connect, so buffering them too would double-emit.
   */
  route(kind: FrameKind, payload: FramePayload): void {
    const id = generateId();
    if (kind === 'event') this.enqueue(id, kind, payload);
    this.bus.publish('ws:dispatch', { id, kind, payload });
  }

  private enqueue(id: string, kind: FrameKind, payload: FramePayload): void {
    if (this.maxSize <= 0) return;
    if (this.pending.size >= this.maxSize) {
      // Drop oldest — Map iteration order = insertion order.
      const oldestKey = this.pending.keys().next().value;
      if (oldestKey !== undefined) this.pending.delete(oldestKey);
    }
    this.pending.set(id, { id, kind, payload, enqueuedAt: Date.now() });
  }

  /**
   * New-leader replay: gather still-pending dispatches from all tabs (including
   * this one), transmit each over the fresh socket, then signal every
   * originator to drop its entry. `isValid` lets the caller bail if the socket
   * was replaced again while we were gathering (avoids replaying onto a socket
   * that's already gone, which would drop entries that never actually sent).
   */
  async replay(isValid: () => boolean = () => true): Promise<void> {
    const entries = await this.gather();
    if (!isValid()) return;
    if (entries.length === 0) return;

    let sent = 0;
    for (const e of entries) {
      this.transmit(e.kind, e.payload);
      // Remove from own pending (publish doesn't echo to self) and tell any
      // other tab that originated the same id to drop it as well.
      this.pending.delete(e.id);
      this.bus.publish('ws:dispatch-flushed', { id: e.id });
      sent++;
    }
    this.log.info('[SharedWS] replayed pending dispatches', { count: sent });
  }

  /**
   * Cross-tab pending-dispatch gather. Broadcasts a one-shot request, collects
   * for a short window, dedups by id (so multiple tabs holding the same id
   * don't double-replay).
   */
  private gather(timeoutMs = 100): Promise<ReplayEntry[]> {
    const seen = new Map<string, ReplayEntry>();
    for (const e of this.pending.values()) {
      seen.set(e.id, { id: e.id, kind: e.kind, payload: e.payload });
    }
    const replyId = generateId();

    return new Promise((resolve) => {
      const unsub = this.bus.subscribe<{ entries: OutboxEntry[] }>(
        `ws:pending:${replyId}`,
        (msg) => {
          for (const e of msg.entries) {
            if (!seen.has(e.id)) seen.set(e.id, { id: e.id, kind: e.kind, payload: e.payload });
          }
        },
      );
      this.bus.publish('ws:gather-pending', { replyId });
      setTimeout(() => {
        unsub();
        resolve([...seen.values()]);
      }, timeoutMs);
    });
  }

  [Symbol.dispose](): void {
    for (const unsub of this.cleanups) unsub();
    this.cleanups = [];
    this.pending.clear();
  }
}
