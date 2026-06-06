import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SharedWebSocket } from '../src/SharedWebSocket';
import { MockWebSocket } from './mocks/websocket';
import type { ChannelAckResult } from '../src/types';

/** Phoenix-ish matcher: an `ack` frame for the channel decides ok/reject. */
const ackMatcher = (frame: unknown, channel: string): ChannelAckResult => {
  const f = frame as { event?: string; channel?: string; status?: string };
  if (f.channel !== channel || f.event !== 'ack') return 'pending';
  return f.status === 'ok' ? 'ok' : 'reject';
};

const ack = (channel: string, status: 'ok' | 'error') =>
  JSON.stringify({ event: 'ack', channel, status });

async function makeLeader(events: Record<string, unknown> = {}) {
  const ws = new SharedWebSocket('wss://x', {
    electionTimeout: 50,
    events: { channelAckMatcher: ackMatcher, channelAckTimeout: 100, ...events },
  });
  const cp = ws.connect();
  await vi.advanceTimersByTimeAsync(80);
  await cp;
  MockWebSocket.last().open();
  return ws;
}

describe('channel().ready (ack matching)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves on an ok ack', async () => {
    const ws = await makeLeader();
    const ch = ws.channel('room:1');
    MockWebSocket.last().emit(ack('room:1', 'ok'));
    await expect(ch.ready).resolves.toBeUndefined();
    ws.disconnect();
  });

  it('rejects on an error ack', async () => {
    const ws = await makeLeader();
    const ch = ws.channel('room:1');
    const ready = ch.ready;
    MockWebSocket.last().emit(ack('room:1', 'error'));
    await expect(ready).rejects.toThrow(/rejected/);
    ws.disconnect();
  });

  it('ignores non-matching frames until its own ack arrives', async () => {
    const ws = await makeLeader();
    const ch = ws.channel('room:1');
    const sock = MockWebSocket.last();
    sock.emit(ack('room:2', 'ok')); // different channel → pending
    sock.emit(JSON.stringify({ event: 'msg', channel: 'room:1' })); // not an ack → pending
    sock.emit(ack('room:1', 'ok')); // ours → resolve
    await expect(ch.ready).resolves.toBeUndefined();
    ws.disconnect();
  });

  it('rejects on ack timeout', async () => {
    const ws = await makeLeader();
    const ch = ws.channel('room:1');
    const ready = ch.ready;
    await vi.advanceTimersByTimeAsync(150); // > channelAckTimeout (100)
    await expect(ready).rejects.toThrow(/timeout/);
    ws.disconnect();
  });

  it('rejects if the channel is left before the ack', async () => {
    const ws = await makeLeader();
    const ch = ws.channel('room:1');
    const ready = ch.ready;
    ch.leave();
    await expect(ready).rejects.toThrow(/left before ack/);
    ws.disconnect();
  });

  it('resolves immediately when no matcher is configured', async () => {
    const ws = await makeLeader({ channelAckMatcher: undefined });
    const ch = ws.channel('room:1');
    await expect(ch.ready).resolves.toBeUndefined();
    ws.disconnect();
  });
});
