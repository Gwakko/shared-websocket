export type SocketState = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type TabRole = 'leader' | 'follower';
export type Unsubscribe = () => void;
export type EventHandler = (data: any) => void;

export interface BusMessage {
  id: string;
  source: string;
  topic: string;
  type: 'publish' | 'request' | 'response' | 'broadcast';
  data: unknown;
  timestamp: number;
}

export interface SharedWebSocketOptions {
  protocols?: string[];
  reconnect?: boolean;
  reconnectMaxDelay?: number;
  heartbeatInterval?: number;
  electionTimeout?: number;
  leaderHeartbeat?: number;
  leaderTimeout?: number;
  sendBuffer?: number;
  auth?: () => string | Promise<string>;
}
