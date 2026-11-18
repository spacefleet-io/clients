/**
 * "Play on TV" transport (UX-TV-02): the account's peer relay on our API (`/p2p/discovery/*`, `/p2p/relay/*`), so the phone
 * and the TV need not share a Wi-Fi. `createHttpRelayTransport` is the apps' HTTP + Server-Sent-Events client; the channel on
 * top seals every message with the account key (`seal.ts`) and drops what does not open, is replayed or comes from the wrong
 * sender. Network, EventSource and clocks are injected so the tests run it without a device.
 */
import { clientIdentityHeaders } from "@space/shared/appVersion";
import {
  buildMessage,
  createReplayGuard,
  describeBody,
  type RemoteBody,
} from "./protocol";
import type { RemoteSealer, SealedEnvelope } from "./seal";

export type PeerKind = "tv" | "mobile";

export type RelayPeer = { peerId: string; kind: string; name: string | null; updatedAt: number };

export type RegisterResult = "ok" | "refused" | "unauthorized" | "error";

/** One relayed event as the stream delivers it (`envelope` is whatever the sender put there: opened by the channel). */
export type RelayEvent = { fromPeerId: string; envelope: unknown };

export type ListenStatus = "open" | "closed";

/** Why the relay could not list the account's devices: never shown as "no TV" (that hid real failures). */
export type PeerListFailure = { reason: "signed_out" } | { reason: "offline" } | { reason: "server"; status: number };
export type PeerListing = { ok: true; peers: RelayPeer[] } | ({ ok: false } & PeerListFailure);

export type RelayTransport = {
  readonly peerId: string;
  register: (kind: PeerKind) => Promise<RegisterResult>;
  listPeers: () => Promise<PeerListing>;
  /** How many live streams of the target got it (0 = the TV is not listening); null when the request failed. */
  send: (toPeerId: string, envelope: SealedEnvelope) => Promise<number | null>;
  /** Keeps a stream open (reconnecting) until the returned stop is called. */
  listen: (onEvent: (event: RelayEvent) => void, onStatus?: (status: ListenStatus) => void) => () => void;
};

export type Logger = (event: string, data?: Record<string, unknown>) => void;

/** The slice of react-native-sse's EventSource the transport uses (a fake in tests). */
export type EventSourceLike = {
  addEventListener: (type: string, listener: (event: { data?: string | null }) => void) => void;
  close: () => void;
};
export type EventSourceFactory = (url: string, headers: Record<string, string>) => EventSourceLike;

type FetchLike = (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
}>;

export type HttpRelayOptions = {
  peerId: string;
  getApiBaseUrl: () => string;
  getToken: () => string | null;
  fetch: FetchLike;
  openEventSource: EventSourceFactory;
  appId?: string;
  log?: Logger;
  /** Reconnect delay after the stream drops (the server closes every stream after 5 minutes). */
  reconnectMs?: number;
  /** Reconnect when nothing (not even the 20 s ping) arrived for this long. */
  staleMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
};

export const createHttpRelayTransport = (options: HttpRelayOptions): RelayTransport => {
  const appId = options.appId ?? "badger";
  const log: Logger = options.log ?? (() => undefined);
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? Date.now;
  const base = () => options.getApiBaseUrl().replace(/\/+$/, "");
  const headers = (token: string): Record<string, string> => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "x-space-app": appId,
    ...clientIdentityHeaders(),
  });

  return {
    peerId: options.peerId,
    async register(kind) {
      const token = options.getToken();
      if (!token) return "unauthorized";
      try {
        const res = await options.fetch(`${base()}/p2p/discovery/register`, {
          method: "POST",
          headers: headers(token),
          body: JSON.stringify({ peerId: options.peerId, kind }),
        });
        if (res.ok) return "ok";
        log("register.refused", { status: res.status, kind });
        if (res.status === 401) return "unauthorized";
        return res.status === 403 || res.status === 409 ? "refused" : "error";
      } catch (error) {
        log("register.failed", { error: String(error) });
        return "error";
      }
    },
    async listPeers() {
      const token = options.getToken();
      if (!token) return { ok: false, reason: "signed_out" };
      try {
        const res = await options.fetch(`${base()}/p2p/discovery/peers?peerId=${encodeURIComponent(options.peerId)}`, {
          headers: headers(token),
        });
        if (!res.ok) {
          log("peers.failed", { status: res.status });
          return { ok: false, reason: "server", status: res.status };
        }
        const body = (await res.json()) as { peers?: unknown };
        const peers = Array.isArray(body.peers) ? body.peers : [];
        const list = peers.flatMap((raw): RelayPeer[] => {
          if (typeof raw !== "object" || raw === null) return [];
          const peer = raw as Record<string, unknown>;
          if (typeof peer.peerId !== "string" || typeof peer.kind !== "string") return [];
          return [{
            peerId: peer.peerId,
            kind: peer.kind,
            name: typeof peer.name === "string" && peer.name.trim() ? peer.name.trim() : null,
            updatedAt: typeof peer.updatedAt === "number" ? peer.updatedAt : 0,
          }];
        });
        return { ok: true, peers: list };
      } catch (error) {
        log("peers.failed", { error: String(error) });
        return { ok: false, reason: "offline" };
      }
    },
    async send(toPeerId, envelope) {
      const token = options.getToken();
      if (!token) return null;
      try {
        const res = await options.fetch(`${base()}/p2p/relay/send`, {
          method: "POST",
          headers: headers(token),
          body: JSON.stringify({ fromPeerId: options.peerId, toPeerId, envelope }),
        });
        if (!res.ok) {
          log("send.failed", { status: res.status });
          return null;
        }
        const body = (await res.json()) as { delivered?: unknown };
        return typeof body.delivered === "number" ? body.delivered : 0;
      } catch (error) {
        log("send.failed", { error: String(error) });
        return null;
      }
    },
    listen(onEvent, onStatus) {
      let stopped = false;
      let source: EventSourceLike | null = null;
      let reconnectTimer: unknown = null;
      let watchdog: unknown = null;
      let lastEventAt = now();
      const reconnectMs = options.reconnectMs ?? 2_000;
      const staleMs = options.staleMs ?? 50_000;

      const scheduleReconnect = (reason: string) => {
        source?.close();
        source = null;
        onStatus?.("closed");
        if (stopped || reconnectTimer !== null) return;
        log("stream.reconnect", { reason, inMs: reconnectMs });
        reconnectTimer = setTimer(() => {
          reconnectTimer = null;
          connect();
        }, reconnectMs);
      };

      const armWatchdog = () => {
        if (watchdog !== null) clearTimer(watchdog);
        watchdog = setTimer(() => {
          watchdog = null;
          if (stopped) return;
          if (now() - lastEventAt >= staleMs) scheduleReconnect("stale");
          armWatchdog();
        }, staleMs);
      };

      const connect = () => {
        if (stopped) return;
        const token = options.getToken();
        if (!token) {
          scheduleReconnect("no_token");
          return;
        }
        const url = `${base()}/p2p/relay/stream?peerId=${encodeURIComponent(options.peerId)}`;
        log("stream.connect", {});
        const es = options.openEventSource(url, {
          Authorization: `Bearer ${token}`,
          "x-space-app": appId,
          ...clientIdentityHeaders(),
        });
        source = es;
        lastEventAt = now();
        es.addEventListener("open", () => {
          lastEventAt = now();
          log("stream.open", {});
          onStatus?.("open");
        });
        es.addEventListener("ping", () => {
          lastEventAt = now();
        });
        es.addEventListener("message", (event) => {
          lastEventAt = now();
          if (!event.data) return;
          try {
            const parsed = JSON.parse(event.data) as Record<string, unknown>;
            if (typeof parsed.fromPeerId !== "string") return;
            onEvent({ fromPeerId: parsed.fromPeerId, envelope: parsed.envelope });
          } catch (error) {
            log("stream.parse_failed", { error: String(error) });
          }
        });
        es.addEventListener("error", () => {
          if (source !== es) return;
          scheduleReconnect("error");
        });
        es.addEventListener("close", () => {
          if (source !== es) return;
          scheduleReconnect("closed");
        });
      };

      connect();
      armWatchdog();
      return () => {
        stopped = true;
        if (reconnectTimer !== null) clearTimer(reconnectTimer);
        if (watchdog !== null) clearTimer(watchdog);
        reconnectTimer = null;
        watchdog = null;
        source?.close();
        source = null;
        log("stream.stopped", {});
      };
    },
  };
};

export type PlayOnTvChannel = {
  readonly peerId: string;
  send: (toPeerId: string, body: RemoteBody) => Promise<number | null>;
  /** Opens the stream; `onMessage` gets each valid, fresh, sealed message. Returns stop. */
  listen: (onMessage: (fromPeerId: string, body: RemoteBody) => void, onStatus?: (status: ListenStatus) => void) => () => void;
};

export const createPlayOnTvChannel = (deps: {
  transport: RelayTransport;
  sealer: RemoteSealer;
  log?: Logger;
  now?: () => number;
}): PlayOnTvChannel => {
  const log: Logger = deps.log ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const guard = createReplayGuard();
  return {
    peerId: deps.transport.peerId,
    async send(toPeerId, body) {
      const envelope = deps.sealer.seal(buildMessage(deps.transport.peerId, toPeerId, body, now()));
      const delivered = await deps.transport.send(toPeerId, envelope);
      log("send", { ...describeBody(body), delivered });
      return delivered;
    },
    listen(onMessage, onStatus) {
      return deps.transport.listen((event) => {
        const message = deps.sealer.open(event.envelope);
        if (!message) {
          log("receive.dropped", { reason: "unopenable" });
          return;
        }
        const verdict = guard.check(message, event.fromPeerId, deps.transport.peerId, now());
        if (verdict !== "ok") {
          log("receive.dropped", { reason: verdict, type: message.body.type });
          return;
        }
        log("receive", describeBody(message.body));
        onMessage(event.fromPeerId, message.body);
      }, onStatus);
    },
  };
};

/** A fresh peer id per app run: the API binds it to the session and drops the session's previous one (no duplicate TVs). */
export const newPeerId = (kind: PeerKind): string =>
  `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
