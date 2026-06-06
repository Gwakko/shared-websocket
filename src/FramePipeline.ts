import type { EventProtocol, FrameKind, FramePayload, Logger, Middleware } from './types';

/** The minimum a frame sink must expose for the pipeline to write to it. */
interface FrameSink {
  send(data: unknown): void;
}

/**
 * Outgoing frame pipeline — the single place a structured `(kind, payload)` is
 * turned into a wire frame and written to the socket:
 *
 *   buildFrame (custom frameBuilder → default)  →  outgoing middleware  →  send
 *
 * Extracted from SharedWebSocket so the build/middleware/send logic lives in
 * one cohesive unit. The owner keeps the socket; it's handed in via
 * `setSocket()` on each leader handover (and cleared on demotion).
 */
export class FramePipeline {
  private socket: FrameSink | null = null;
  private readonly middleware: Middleware[] = [];

  constructor(
    private readonly proto: EventProtocol,
    private readonly log: Logger,
  ) {}

  /** Point the pipeline at the current leader socket (or `null` on demotion). */
  setSocket(socket: FrameSink | null): void {
    this.socket = socket;
  }

  hasSocket(): boolean {
    return this.socket !== null;
  }

  /** Register an outgoing middleware. Return `null` from it to drop a frame. */
  use(fn: Middleware): void {
    this.middleware.push(fn);
  }

  /** Build, run middleware, and write to the socket. No-op without a socket. */
  transmit(kind: FrameKind, payload: FramePayload): void {
    if (!this.socket) return;
    let frame: unknown = this.buildFrame(kind, payload);
    if (frame === null) {
      this.log.debug('[SharedWS] ✗ frameBuilder dropped frame', kind, this.frameLabel(kind, payload));
      return;
    }
    for (const mw of this.middleware) {
      frame = mw(frame);
      if (frame === null) {
        this.log.debug('[SharedWS] ✗ outgoing dropped by middleware', kind, this.frameLabel(kind, payload));
        return;
      }
    }
    // Auth frames carry a token — never log payload or wire frame.
    if (kind === 'auth-login') {
      this.log.debug('[SharedWS] → send', kind, '(token redacted)');
    } else {
      this.log.debug('[SharedWS] → send', kind, this.frameLabel(kind, payload), { payload, frame });
    }
    this.socket.send(frame);
  }

  /**
   * Build the wire frame for a given kind. Honors custom `frameBuilder`.
   * Return-value contract:
   *   - any concrete value → use as the frame
   *   - `null`             → drop the frame (intentional filter)
   *   - `undefined`        → fall back to the default builder for this kind
   */
  private buildFrame(kind: FrameKind, payload: FramePayload): unknown {
    if (this.proto.frameBuilder) {
      const result = this.proto.frameBuilder(kind, payload);
      if (result !== undefined) return result;
      // undefined → fall through to default for this kind
    }
    return this.defaultFrameBuilder(kind, payload);
  }

  /** Legacy two-key builder — preserved as the default for back-compat. */
  private defaultFrameBuilder(kind: FrameKind, p: FramePayload): unknown {
    let eventName: string;
    let dataPart: unknown;

    switch (kind) {
      case 'event':
        // Channel-scoped events join with `:` for wire compat (Pusher convention).
        eventName = p.channel ? `${p.channel}:${p.event ?? ''}` : (p.event ?? this.proto.defaultEvent);
        dataPart = p.data;
        break;
      case 'subscribe':
        eventName = this.proto.channelJoin;
        dataPart = { channel: p.channel };
        break;
      case 'unsubscribe':
        eventName = this.proto.channelLeave;
        dataPart = { channel: p.channel };
        break;
      case 'topic-subscribe':
        eventName = this.proto.topicSubscribe;
        dataPart = { topic: p.topic };
        break;
      case 'topic-unsubscribe':
        eventName = this.proto.topicUnsubscribe;
        dataPart = { topic: p.topic };
        break;
      case 'auth-login':
        eventName = this.proto.authLogin;
        dataPart = { token: p.data };
        break;
      case 'auth-logout':
        eventName = this.proto.authLogout;
        dataPart = {};
        break;
    }

    return {
      ...(p.extras ?? {}),
      [this.proto.eventField]: eventName,
      [this.proto.dataField]: dataPart,
    };
  }

  /**
   * Human-readable headline for log lines — picks the most relevant field
   * out of the structured payload so log scanners aren't reading objects.
   */
  private frameLabel(kind: FrameKind, p: FramePayload): string {
    switch (kind) {
      case 'event':              return p.event ?? '?';
      case 'subscribe':
      case 'unsubscribe':        return p.channel ?? '?';
      case 'topic-subscribe':
      case 'topic-unsubscribe':  return p.topic ?? '?';
      case 'auth-login':         return '(redacted)';
      case 'auth-logout':        return '';
    }
  }
}
