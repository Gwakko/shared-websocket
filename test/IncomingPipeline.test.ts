import { describe, it, expect } from 'vitest';
import { IncomingPipeline } from '../src/IncomingPipeline';
import type { EventProtocol, Logger } from '../src/types';

const NOOP_LOG: Logger = { debug() {}, info() {}, warn() {}, error() {} };

// process() only reads eventField/dataField/defaultEvent; cast a minimal proto.
const PROTO = {
  eventField: 'event',
  dataField: 'data',
  defaultEvent: 'message',
} as unknown as EventProtocol;

describe('IncomingPipeline', () => {
  it('extracts event + data from the envelope', () => {
    const p = new IncomingPipeline(PROTO, NOOP_LOG);
    const frame = { event: 'order.created', data: { id: 1 } };
    expect(p.process(frame)).toEqual({
      event: 'order.created',
      data: { id: 1 },
      raw: frame,
    });
  });

  it('falls back to defaultEvent when the event field is absent', () => {
    const p = new IncomingPipeline(PROTO, NOOP_LOG);
    const env = p.process({ data: 5 });
    expect(env?.event).toBe('message');
    expect(env?.data).toBe(5);
  });

  it('drops a frame when middleware returns null', () => {
    const p = new IncomingPipeline(PROTO, NOOP_LOG);
    p.use(() => null);
    expect(p.process({ event: 'x', data: 1 })).toBeNull();
  });

  it('lets middleware transform the frame before extraction', () => {
    const p = new IncomingPipeline(PROTO, NOOP_LOG);
    p.use((m) => ({ ...(m as object), event: 'rewritten', data: 99 }));
    const env = p.process({ event: 'orig', data: 0 });
    expect(env?.event).toBe('rewritten');
    expect(env?.data).toBe(99);
  });

  it('applies a per-event deserializer only to its event', () => {
    const p = new IncomingPipeline(PROTO, NOOP_LOG);
    p.deserializer('bin', (d) => `decoded:${d}`);

    expect(p.process({ event: 'bin', data: 'raw' })?.data).toBe('decoded:raw');
    expect(p.process({ event: 'other', data: 'x' })?.data).toBe('x');
  });
});
