import { describe, it, expect } from 'vitest';
import { SharedWebSocket } from '../src/SharedWebSocket';
import { flushMicrotasks } from './mocks/broadcast-channel';

/**
 * sync() is pure cross-tab state over BroadcastChannel — no socket, no leader.
 * So these run on plain constructed instances (no connect / fake timers needed).
 */
const makeWs = () => new SharedWebSocket('wss://x');

describe('sync()', () => {
  it('getSync returns a locally set value immediately', () => {
    const ws = makeWs();
    ws.sync('cart', { items: [1, 2] });
    expect(ws.getSync('cart')).toEqual({ items: [1, 2] });
    expect(ws.getSync('missing')).toBeUndefined();
    ws.disconnect();
  });

  it('propagates to other tabs (getSync + onSync)', async () => {
    const a = makeWs();
    const b = makeWs();
    const seen: unknown[] = [];
    b.onSync('theme', (v) => seen.push(v));

    a.sync('theme', 'dark');
    await flushMicrotasks();

    expect(b.getSync('theme')).toBe('dark');
    expect(seen).toEqual(['dark']);

    a.disconnect();
    b.disconnect();
  });

  it('fires onSync on the originating tab too (broadcast self-delivers)', () => {
    const a = makeWs();
    const seen: unknown[] = [];
    a.onSync('x', (v) => seen.push(v));

    a.sync('x', 1);

    expect(seen).toEqual([1]); // synchronous self-delivery
    a.disconnect();
  });

  it('keeps keys independent and is last-write-wins', async () => {
    const a = makeWs();
    const b = makeWs();

    a.sync('a', 1);
    a.sync('b', 2);
    a.sync('a', 3);
    await flushMicrotasks();

    expect(b.getSync('a')).toBe(3);
    expect(b.getSync('b')).toBe(2);

    a.disconnect();
    b.disconnect();
  });

  it('onSync unsubscribe stops further updates', async () => {
    const a = makeWs();
    const b = makeWs();
    const seen: unknown[] = [];
    const off = b.onSync('k', (v) => seen.push(v));

    a.sync('k', 1);
    await flushMicrotasks();
    off();
    a.sync('k', 2);
    await flushMicrotasks();

    expect(seen).toEqual([1]);

    a.disconnect();
    b.disconnect();
  });

  it('flows from any tab without a connection (no socket roundtrip)', async () => {
    const a = makeWs();
    const b = makeWs();

    b.sync('fromB', 'v');
    await flushMicrotasks();

    expect(a.getSync('fromB')).toBe('v');

    a.disconnect();
    b.disconnect();
  });
});
