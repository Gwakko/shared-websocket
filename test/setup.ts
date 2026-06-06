import { beforeEach } from 'vitest';
import { MockBroadcastChannel, resetBroadcastChannels } from './mocks/broadcast-channel';
import { MockWebSocket } from './mocks/websocket';

// Install browser globals the library reaches for. `document`/`window` are left
// undefined on purpose — the library guards on `typeof document !== 'undefined'`,
// so unit tests run headless without the visibility/unload wiring.
(globalThis as unknown as { BroadcastChannel: unknown }).BroadcastChannel = MockBroadcastChannel;
(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;

beforeEach(() => {
  resetBroadcastChannels();
  MockWebSocket.reset();
});
