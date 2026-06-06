import type { EventProtocol, Logger, Middleware } from './types';

/** Envelope produced from a raw incoming frame, ready to fan out to tabs. */
export interface IncomingEnvelope {
  event: string;
  data: unknown;
  /** Full deserialized frame (post-middleware) — for handlers needing top-level fields. */
  raw: unknown;
}

/**
 * Incoming frame pipeline — the mirror of FramePipeline. Turns a raw,
 * already-deserialized socket frame into an `{ event, data, raw }` envelope:
 *
 *   incoming middleware  →  extract event/data  →  per-event deserializer
 *
 * Runs on the leader (the tab that owns the socket); the envelope is then
 * broadcast to every tab for local fan-out. Extracted from SharedWebSocket so
 * the receive-side transform lives in one cohesive unit.
 */
export class IncomingPipeline {
  private readonly middleware: Middleware[] = [];
  private readonly deserializers = new Map<string, (data: unknown) => unknown>();

  constructor(
    private readonly proto: EventProtocol,
    private readonly log: Logger,
  ) {}

  /** Register an incoming middleware. Return `null` from it to drop a frame. */
  use(fn: Middleware): void {
    this.middleware.push(fn);
  }

  /** Register a per-event deserializer, applied after global deserialize. */
  deserializer(event: string, fn: (data: unknown) => unknown): void {
    this.deserializers.set(event, fn);
  }

  /**
   * Transform a raw frame into an envelope, or `null` if middleware dropped it.
   */
  process(raw: unknown): IncomingEnvelope | null {
    let data: unknown = raw;
    for (const mw of this.middleware) {
      data = mw(data);
      if (data === null) {
        this.log.debug('[SharedWS] ✗ incoming dropped by middleware', { raw });
        return null;
      }
    }

    const msg = data as Record<string, unknown> | null | undefined;
    const event = (msg?.[this.proto.eventField] as string) ?? this.proto.defaultEvent;
    let payload = msg?.[this.proto.dataField] ?? data;

    // Per-event deserializer transforms data after global deserialize.
    const eventDeserializer = this.deserializers.get(event);
    if (eventDeserializer) {
      payload = eventDeserializer(payload);
    }

    this.log.debug('[SharedWS] ← recv', event, { data: payload, raw: data });
    return { event, data: payload, raw: data };
  }
}
