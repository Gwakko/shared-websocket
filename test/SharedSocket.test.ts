import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SharedSocket } from '../src/SharedSocket';
import { MockWebSocket } from './mocks/websocket';

describe('SharedSocket — heartbeat liveness watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends pings while the connection is alive', async () => {
    const s = new SharedSocket('wss://x', { heartbeatInterval: 1000, heartbeatTimeout: 2500 });
    await s.connect();
    MockWebSocket.last().open();

    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.last().sent.length).toBe(1); // one ping, still alive

    s[Symbol.dispose]();
  });

  it('force-reconnects when nothing inbound arrives within heartbeatTimeout', async () => {
    const s = new SharedSocket('wss://x', { heartbeatInterval: 1000, heartbeatTimeout: 2500, reconnect: true });
    await s.connect();
    MockWebSocket.last().open();
    expect(MockWebSocket.instances.length).toBe(1);

    // 1000ms & 2000ms ticks: still within window → ping. 3000ms: silent past
    // the 2500ms window → reconnect (a fresh socket is created).
    await vi.advanceTimersByTimeAsync(3000);
    expect(MockWebSocket.instances.length).toBe(2);

    s[Symbol.dispose]();
  });

  it('inbound traffic resets the watchdog (no spurious reconnect)', async () => {
    const s = new SharedSocket('wss://x', { heartbeatInterval: 1000, heartbeatTimeout: 2500, reconnect: true });
    await s.connect();
    const ws = MockWebSocket.last();
    ws.open();

    await vi.advanceTimersByTimeAsync(2000);
    ws.emit(JSON.stringify({ hello: 1 })); // resets lastInboundAt
    await vi.advanceTimersByTimeAsync(2000); // 4000 total, but <2500 since last inbound

    expect(MockWebSocket.instances.length).toBe(1); // never reconnected

    s[Symbol.dispose]();
  });

  it('watchdog is OFF by default (legacy fire-and-forget)', async () => {
    const s = new SharedSocket('wss://x', { heartbeatInterval: 1000 }); // no heartbeatTimeout
    await s.connect();
    MockWebSocket.last().open();

    await vi.advanceTimersByTimeAsync(10_000); // long silence
    expect(MockWebSocket.instances.length).toBe(1); // stays put

    s[Symbol.dispose]();
  });
});
