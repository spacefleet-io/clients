import { runtimeEventFrameSchema, type RuntimeEventFrame } from "@space/runtime-contracts/envelope";
import type { RuntimeSessionHandle } from "./session";

type WsLike = {
  addEventListener: (type: string, listener: (event?: unknown) => void) => void;
  send: (data: string) => void;
  close: () => void;
  readyState: number;
};

type WsCtor = new (url: string) => WsLike;

export type RuntimeEventStreamConfig = {
  session: RuntimeSessionHandle;
  runtimeBaseUrl: string;
  apps: string[];
  channels: string[];
  WebSocketImpl?: WsCtor;
  reconnectMs?: number;
};

export type RuntimeEventStreamHandle = {
  start(): Promise<void>;
  stop(): void;
  subscribe(listener: (frame: RuntimeEventFrame) => void): () => void;
};

/** Close code the runtime sends when it ended the socket's session. */
const RUNTIME_WS_CLOSE_SESSION_EXPIRED = 4401;

const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "");

const toWsUrl = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/runtime/events";
  url.search = "";
  return url;
};

export const createRuntimeEventStream = (config: RuntimeEventStreamConfig): RuntimeEventStreamHandle => {
  const WebSocketImpl = config.WebSocketImpl ?? (WebSocket as unknown as WsCtor);
  const reconnectMs = config.reconnectMs ?? 3_000;
  const runtimeBaseUrl = normalizeUrl(config.runtimeBaseUrl);
  const listeners = new Set<(frame: RuntimeEventFrame) => void>();
  let ws: WsLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const notify = (frame: RuntimeEventFrame) => {
    for (const listener of listeners) listener(frame);
  };

  const clearReconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectMs);
  };

  const connect = async () => {
    if (stopped) return;
    let token: string;
    try {
      token = await config.session.getToken();
    } catch {
      scheduleReconnect();
      return;
    }
    const wsUrl = toWsUrl(runtimeBaseUrl);
    wsUrl.searchParams.set("token", token);

    const socket = new WebSocketImpl(wsUrl.toString());

    socket.addEventListener("open", () => {
      clearReconnect();
      socket.send(
        JSON.stringify({
          type: "subscribe",
          apps: config.apps,
          channels: config.channels,
        }),
      );
    });

    socket.addEventListener("message", (event: unknown) => {
      const maybeData = (event as { data?: unknown } | undefined)?.data;
      if (typeof maybeData !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(maybeData);
      } catch {
        return;
      }
      const parsed = runtimeEventFrameSchema.safeParse(raw);
      if (!parsed.success) return; // drop invalid frames
      notify(parsed.data as RuntimeEventFrame);
    });

    const onDisconnect = () => {
      if (ws === socket) ws = null;
      if (!stopped) scheduleReconnect();
    };

    // The runtime closes with 4401 when it ended this session (logout, expiry,
    // token rotation): drop the cached token so the reconnect logs in again
    // instead of presenting the dead one.
    socket.addEventListener("close", (event?: unknown) => {
      if ((event as { code?: unknown } | undefined)?.code === RUNTIME_WS_CLOSE_SESSION_EXPIRED) {
        config.session.invalidate();
      }
      onDisconnect();
    });
    socket.addEventListener("error", onDisconnect);

    ws = socket;
  };

  return {
    async start() {
      stopped = false;
      await connect();
    },

    stop() {
      stopped = true;
      clearReconnect();
      if (ws) {
        try {
          ws.close();
        } catch {
          // no-op
        }
        ws = null;
      }
    },

    subscribe(listener: (frame: RuntimeEventFrame) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
