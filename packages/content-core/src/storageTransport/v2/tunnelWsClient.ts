import type { StorageTunnelClientFrame, StorageTunnelGatewayFrame } from "./types";

// Bun types `onerror` with ErrorEvent, the DOM and React Native with Event: declared as a method so both fit.
type WsLike = {
  onopen: ((event: Event) => void) | null;
  onerror: { handler(event: Event): void }["handler"] | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send: (data: string) => void;
  close: () => void;
};

type WsCtor = new (url: string) => WsLike;

type PendingRequest = {
  resolve: (frame: StorageTunnelGatewayFrame) => void;
  reject: (error: Error) => void;
};

export type StorageTunnelWsConnection = {
  sendFrame: (frame: StorageTunnelClientFrame) => Promise<StorageTunnelGatewayFrame>;
  close: () => void;
  isOpen: () => boolean;
};

const isGatewayFramePayload = (payload: unknown): payload is { frame: StorageTunnelGatewayFrame } =>
  Boolean(payload && typeof payload === "object" && "frame" in (payload as Record<string, unknown>));

export const createStorageTunnelWsConnection = async ({
  wsEndpoint,
  token,
  sessionId,
  WebSocketImpl = WebSocket,
}: {
  wsEndpoint: string;
  token: string;
  sessionId: string;
  WebSocketImpl?: WsCtor;
}): Promise<StorageTunnelWsConnection> => {
  const url = new URL(wsEndpoint);
  url.searchParams.set("token", token);
  url.searchParams.set("sessionId", sessionId);

  const ws = new WebSocketImpl(url.toString());
  const pending: PendingRequest[] = [];
  let open = false;
  let closed = false;

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      open = true;
      resolve();
    };
    ws.onerror = () => reject(new Error("ws_connect_failed"));
    ws.onclose = () => {
      closed = true;
      if (!open) {
        reject(new Error("ws_connect_closed"));
      }
    };
  });

  ws.onmessage = (event) => {
    const text = typeof event.data === "string" ? event.data : String(event.data ?? "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const next = pending.shift();
      if (next) next.reject(new Error("invalid_json"));
      return;
    }

    if (parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
      const message = String((parsed as { error?: unknown }).error ?? "unknown_error");
      const next = pending.shift();
      if (next) next.reject(new Error(message));
      return;
    }

    if (!isGatewayFramePayload(parsed)) {
      const next = pending.shift();
      if (next) next.reject(new Error("invalid_gateway_frame"));
      return;
    }
    const next = pending.shift();
    if (next) next.resolve(parsed.frame);
  };

  ws.onclose = () => {
    open = false;
    closed = true;
    while (pending.length > 0) {
      const next = pending.shift();
      if (next) next.reject(new Error("ws_closed"));
    }
  };

  ws.onerror = () => {
    while (pending.length > 0) {
      const next = pending.shift();
      if (next) next.reject(new Error("ws_error"));
    }
  };

  return {
    sendFrame(frame) {
      if (!open || closed) {
        return Promise.reject(new Error("ws_not_open"));
      }
      return new Promise<StorageTunnelGatewayFrame>((resolve, reject) => {
        pending.push({ resolve, reject });
        ws.send(JSON.stringify({ frame }));
      });
    },
    close() {
      ws.close();
    },
    isOpen() {
      return open && !closed;
    },
  };
};
