import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SharedWebSocket } from '../src/SharedWebSocket';
import { MockWebSocket } from './mocks/websocket';

describe('SharedWebSocket', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function connectAsLeader(url = 'wss://x', options = {}) {
    const ws = new SharedWebSocket(url, { electionTimeout: 50, ...options });
    const cp = ws.connect();
    await vi.advanceTimersByTimeAsync(80); // win election → become leader → create socket
    await cp;
    MockWebSocket.last().open(); // bring the leader socket up
    return ws;
  }

  it('request() from the leader tab resolves locally (does not dead-end on the bus)', async () => {
    const ws = await connectAsLeader();
    expect(ws.tabRole).toBe('leader');

    const p = ws.request<{ ok: boolean }>('foo', { x: 1 });
    // Server answers on the leader's socket.
    MockWebSocket.last().emit(JSON.stringify({ event: 'foo', data: { ok: true } }));

    await expect(p).resolves.toEqual({ ok: true });
    ws.disconnect();
  });

  it('send() from the leader writes a frame to the socket', async () => {
    const ws = await connectAsLeader();
    const before = MockWebSocket.last().sent.length;

    ws.send('chat.message', { text: 'hi' });

    const frames = MockWebSocket.last().sent;
    expect(frames.length).toBe(before + 1);
    expect(JSON.parse(frames.at(-1) as string)).toEqual({ event: 'chat.message', data: { text: 'hi' } });

    ws.disconnect();
  });

  it('on() receives events the leader gets from the socket', async () => {
    const ws = await connectAsLeader();
    const seen: unknown[] = [];
    ws.on('order.created', (d) => seen.push(d));

    MockWebSocket.last().emit(JSON.stringify({ event: 'order.created', data: { id: 5 } }));

    expect(seen).toEqual([{ id: 5 }]);
    ws.disconnect();
  });
});
