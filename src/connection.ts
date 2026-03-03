import WebSocket from "ws";

import type { IncomingMessage, OutgoingMessage } from "./types.js";

export interface DaemonConnectionOptions {
  serverUrl: string;
  apiKey: string;
  onMessage: (msg: IncomingMessage) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

/**
 * Persistent websocket connection with backoff reconnect.
 */
export class DaemonConnection {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1_000;
  private readonly maxReconnectDelay = 30_000;
  private shouldConnect = true;

  constructor(private readonly options: DaemonConnectionOptions) {}

  connect(): void {
    this.shouldConnect = true;
    this.doConnect();
  }

  disconnect(): void {
    this.shouldConnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(msg: OutgoingMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private doConnect(): void {
    if (!this.shouldConnect) {
      return;
    }

    const wsUrl =
      this.options.serverUrl.replace(/^http/, "ws") +
      `/daemon/connect?key=${this.options.apiKey}`;

    console.log(`[Daemon] Connecting to ${this.options.serverUrl}...`);
    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      console.log("[Daemon] Connected to server");
      this.reconnectDelay = 1_000;
      this.options.onConnect();
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as IncomingMessage;
        this.options.onMessage(msg);
      } catch (error) {
        console.error("[Daemon] Invalid message from server:", error);
      }
    });

    this.ws.on("close", () => {
      console.log("[Daemon] Disconnected from server");
      this.options.onDisconnect();
      this.scheduleReconnect();
    });

    this.ws.on("error", (error) => {
      console.error("[Daemon] WebSocket error:", error.message);
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldConnect || this.reconnectTimer) {
      return;
    }

    console.log(`[Daemon] Reconnecting in ${this.reconnectDelay}ms...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.maxReconnectDelay,
    );
  }
}
