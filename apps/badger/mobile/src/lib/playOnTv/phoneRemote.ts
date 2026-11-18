/**
 * The phone side of "Play on TV" (UX-TV-02): starts a title on one of the account's TV apps and is then its remote. Every
 * view the remote screen shows comes from the TV's own `state` messages (position, pause, tracks), never from a guess on
 * the phone, so what the phone shows is what the TV does. Pure: channel, presence and timers are injected.
 */
import type { PlayOnTvChannel, RegisterResult, RelayPeer } from "./channel";
import type { RemoteCommand, StartCommand, TvState } from "./protocol";

/** `connecting`: announcing the phone and sending. `waiting`: sent, no answer yet. `connected`: the TV reports its state. */
export type RemoteStatus = "connecting" | "waiting" | "connected" | "unreachable" | "ended";

export type RemoteView = { status: RemoteStatus; tv: TvState | null };

/** What the phone's buttons send. */
export type RemoteAction = Exclude<RemoteCommand, { type: "start" } | { type: "hello" }>;

export type PhoneRemoteDeps = {
  channel: PlayOnTvChannel;
  /** Announces the phone's peer (kind `mobile`) so its peer id is bound to this session. */
  registerSelf: () => Promise<RegisterResult>;
  tvPeerId: string;
  log?: (event: string, data?: Record<string, unknown>) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** No state from the TV within this long after a command = unreachable. */
  replyTimeoutMs?: number;
  /** The phone's presence heartbeat (the API forgets a peer 45 s after its last one). */
  presenceEveryMs?: number;
};

export type PhoneRemote = {
  start: (command: StartCommand) => Promise<void>;
  /** Re-attach to a TV already playing (asks for its state). */
  resume: () => Promise<void>;
  send: (action: RemoteAction) => Promise<void>;
  /** Pause when the TV plays, play when it is paused: decided from the TV's last state. */
  togglePause: () => Promise<void>;
  view: () => RemoteView;
  subscribe: (listener: (view: RemoteView) => void) => () => void;
  dispose: () => void;
};

export const createPhoneRemote = (deps: PhoneRemoteDeps): PhoneRemote => {
  const log = deps.log ?? (() => undefined);
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const replyTimeoutMs = deps.replyTimeoutMs ?? 15_000;
  const presenceEveryMs = deps.presenceEveryMs ?? 20_000;

  let view: RemoteView = { status: "connecting", tv: null };
  const listeners = new Set<(view: RemoteView) => void>();
  let stopListening: (() => void) | null = null;
  /** The first registration + listen, shared: taps made while it runs wait for it instead of opening a second stream. */
  let listening: Promise<void> | null = null;
  let replyTimer: unknown = null;
  let presenceTimer: unknown = null;
  let disposed = false;

  const setView = (next: RemoteView) => {
    if (next.status !== view.status) log("status", { from: view.status, to: next.status, phase: next.tv?.phase ?? null });
    view = next;
    for (const listener of listeners) listener(view);
  };

  const clearReplyTimer = () => {
    if (replyTimer !== null) clearTimer(replyTimer);
    replyTimer = null;
  };

  const armReplyTimer = (reason: string) => {
    clearReplyTimer();
    replyTimer = setTimer(() => {
      replyTimer = null;
      if (disposed || view.status === "ended") return;
      log("reply_timeout", { reason, afterMs: replyTimeoutMs });
      setView({ ...view, status: "unreachable" });
    }, replyTimeoutMs);
  };

  const keepPresence = () => {
    if (presenceTimer !== null || disposed) return;
    presenceTimer = setTimer(() => {
      presenceTimer = null;
      if (disposed) return;
      void deps.registerSelf().then((result) => log("presence", { result }));
      keepPresence();
    }, presenceEveryMs);
  };

  const ensureListening = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    listening ??= (async () => {
      // A registration that throws is retried by the next tap, as before.
      const registered = await deps.registerSelf().catch((error: unknown) => {
        listening = null;
        throw error;
      });
      log("register", { result: registered });
      if (disposed) return;
      stopListening = deps.channel.listen((fromPeerId, body) => {
        if (fromPeerId !== deps.tvPeerId || body.type !== "state") return;
        clearReplyTimer();
        setView({ status: body.phase === "ended" ? "ended" : "connected", tv: body });
      });
      keepPresence();
    })();
    return listening;
  };

  const deliver = async (body: RemoteCommand, reason: string) => {
    const delivered = await deps.channel.send(deps.tvPeerId, body);
    if (disposed) return;
    if (delivered === null || delivered === 0) {
      log("not_delivered", { type: body.type, delivered });
      clearReplyTimer();
      setView({ ...view, status: "unreachable" });
      return;
    }
    if (view.status !== "connected") setView({ ...view, status: "waiting" });
    armReplyTimer(reason);
  };

  return {
    async start(command) {
      setView({ status: "connecting", tv: null });
      await ensureListening();
      await deliver(command, "start");
    },
    async resume() {
      setView({ ...view, status: "connecting" });
      await ensureListening();
      await deliver({ type: "hello" }, "hello");
    },
    async send(action) {
      await ensureListening();
      await deliver(action, action.type);
    },
    async togglePause() {
      const phase = view.tv?.phase;
      await this.send(phase === "paused" ? { type: "play" } : { type: "pause" });
    },
    view: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      clearReplyTimer();
      if (presenceTimer !== null) clearTimer(presenceTimer);
      presenceTimer = null;
      stopListening?.();
      stopListening = null;
      listeners.clear();
    },
  };
};

/** The TV apps of the account in the phone's "Play on TV" list, named as at pairing (UX-TV-02), sorted by name. */
export const tvTargets = (peers: readonly RelayPeer[], fallbackName: string): Array<{ peerId: string; name: string }> =>
  peers
    .filter((peer) => peer.kind === "tv")
    .map((peer) => ({ peerId: peer.peerId, name: peer.name ?? fallbackName }))
    .sort((a, b) => a.name.localeCompare(b.name));

/** The remote's seek buttons: 10 s back / forward, like the TV's own remote (UX-TV-01). */
export const REMOTE_SEEK_STEP_SECONDS = 10;
