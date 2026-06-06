/**
 * Minimal WebSocket mock for tests. Tests drive the lifecycle explicitly:
 *   const ws = MockWebSocket.last();
 *   ws.open();                       // fire onopen, readyState → OPEN
 *   ws.emit(JSON.stringify({...}));  // fire onmessage with raw data
 *   ws.serverClose(1006);            // fire onclose (abnormal)
 *
 * Sent frames are captured in `.sent` for assertions.
 */
type Handler = ((ev: unknown) => void) | null;

export class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every instance created, in order — lets a test grab the current socket. */
  static instances: MockWebSocket[] = [];
  static reset(): void {
    MockWebSocket.instances = [];
  }
  static last(): MockWebSocket {
    const ws = MockWebSocket.instances.at(-1);
    if (!ws) throw new Error('MockWebSocket: no socket created yet');
    return ws;
  }

  readyState = MockWebSocket.CONNECTING;
  onopen: Handler = null;
  onmessage: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  binaryType = 'blob';
  /** Frames passed to send(). */
  readonly sent: unknown[] = [];

  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[],
  ) {
    MockWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  // ─── test drivers ───────────────────────────────────────
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** Simulate a server- or network-initiated close (does not null handlers). */
  serverClose(code = 1006, reason = 'abnormal'): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}
