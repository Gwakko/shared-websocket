import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageBus } from '../src/MessageBus';
import { SubscriptionRegistry } from '../src/SubscriptionRegistry';
import type { FrameKind, FramePayload, Logger } from '../src/types';

const NOOP_LOG: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe('SubscriptionRegistry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refcounts channels (one server-side join per name)', () => {
    const bus = new MessageBus('subs', 'a');
    const reg = new SubscriptionRegistry(bus, () => {}, NOOP_LOG);

    reg.addChannel('c1');
    reg.addChannel('c1');
    expect([...reg.channelNames()]).toEqual(['c1']);

    reg.removeChannel('c1');
    expect([...reg.channelNames()]).toEqual(['c1']); // one ref remains

    reg.removeChannel('c1');
    expect([...reg.channelNames()]).toEqual([]); // forgotten at zero

    reg[Symbol.dispose]();
    bus[Symbol.dispose]();
  });

  it('replays the union of channels/topics across tabs', async () => {
    const busA = new MessageBus('subs', 'a');
    const busB = new MessageBus('subs', 'b');

    const regA = new SubscriptionRegistry(busA, () => {}, NOOP_LOG); // announces only
    regA.addChannel('c1');
    regA.addTopic('t1');

    const sent: Array<[FrameKind, string | undefined]> = [];
    const regB = new SubscriptionRegistry(
      busB,
      (kind: FrameKind, p: FramePayload) => sent.push([kind, p.channel ?? p.topic]),
      NOOP_LOG,
    );
    regB.addChannel('c2');

    const p = regB.replay();
    await vi.advanceTimersByTimeAsync(200); // gather window + flush
    await p;

    const channels = sent.filter(([k]) => k === 'subscribe').map(([, v]) => v).sort();
    const topics = sent.filter(([k]) => k === 'topic-subscribe').map(([, v]) => v);
    expect(channels).toEqual(['c1', 'c2']); // union across both tabs
    expect(topics).toEqual(['t1']);

    regA[Symbol.dispose]();
    regB[Symbol.dispose]();
    busA[Symbol.dispose]();
    busB[Symbol.dispose]();
  });

  it('aborts replay when isValid() is false (socket changed mid-gather)', async () => {
    const bus = new MessageBus('subs', 'a');
    const sent: FrameKind[] = [];
    const reg = new SubscriptionRegistry(bus, (kind: FrameKind) => sent.push(kind), NOOP_LOG);
    reg.addChannel('c1');

    const p = reg.replay(() => false);
    await vi.advanceTimersByTimeAsync(200);
    await p;

    expect(sent).toEqual([]); // nothing transmitted

    reg[Symbol.dispose]();
    bus[Symbol.dispose]();
  });
});
