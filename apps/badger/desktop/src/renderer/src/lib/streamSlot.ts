/**
 * ACCT-STREAM-01..04 on Badger desktop: the one stream place this app's player holds while it streams, through the
 * shared `StreamSlotGate` (`@space/stream-slots`). The desktop has one player, so one gate for the whole renderer.
 *
 * - `useMpvPlaybackEngine`'s loadStream calls `acquireDesktopStreamSlot()` before a STREAMED source loads, never for an
 *   offline copy (ACCT-STREAM-03). A place already held (next episode, format reload) is reused without a request.
 *   `"cancel"` = the user chose Cancel at "Already playing on {device}. Play here instead?": the load ends as stopped
 *   (no error shown) and the player closes.
 * - Another device takes the place over: the player closes and `StreamSlotPrompt` shows "Playing on {device} now".
 * - The engine's teardown (player closed) calls `releaseDesktopStreamSlot()`.
 *
 * The session token and the player's close action are handed in by `MediaPlaybackController` while it is mounted; the
 * API base URL is read at every request (the API host can change at sign-in).
 */
import { getApiBaseUrl } from "@space/shared/api";
import { createStreamSlotsClient, StreamSlotGate, type StreamSlotsClient } from "@space/stream-slots";
import { profileStore } from "@/lib/profileStore";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "stream-slot" });

export type DesktopStreamSlotDeps = {
  client: StreamSlotsClient;
  getProfileId: () => string | null | undefined;
  /** Closes the player (tears mpv down). */
  closePlayback: () => void;
  timers?: ConstructorParameters<typeof StreamSlotGate>[0]["timers"];
};

/** The renderer's stream place: the gate the prompt follows, and the player's acquire/release. */
export type DesktopStreamSlot = {
  gate: StreamSlotGate;
  acquire: () => Promise<"play" | "cancel">;
  release: () => Promise<void>;
};

export const createDesktopStreamSlot = (deps: DesktopStreamSlotDeps): DesktopStreamSlot => {
  const gate = new StreamSlotGate({
    client: deps.client,
    app: "badger",
    getProfileId: deps.getProfileId,
    onTakenOver: (by) => {
      log.info({ deviceType: by.deviceType }, "stream_slot.taken_over: closing playback");
      deps.closePlayback();
    },
    onError: (error) => log.warn({ err: error instanceof Error ? error.message : String(error) }, "stream_slot.request_failed"),
    log: (event, fields) => log.info(fields, event),
    ...(deps.timers ? { timers: deps.timers } : {}),
  });
  return {
    gate,
    acquire: async (): Promise<"play" | "cancel"> => {
      const answer = await gate.acquire({ owner: "player" });
      log.info({ answer }, "stream_slot.acquire");
      if (answer === "cancel") deps.closePlayback();
      return answer;
    },
    release: () => gate.release("player"),
  };
};

let token: string | null = null;
let closeHandler: (() => void) | null = null;

/** The signed-in session's token, kept current by `MediaPlaybackController`. */
export const setDesktopStreamSlotToken = (next: string | null) => {
  token = next;
};

/**
 * The player's close action, registered by the `MediaPlaybackController` whose playback is open or launching. Returns
 * the unregister, which only clears the handler while it is still this one (another controller may have taken over).
 */
export const setDesktopStreamSlotCloseHandler = (handler: () => void): (() => void) => {
  closeHandler = handler;
  return () => {
    if (closeHandler === handler) closeHandler = null;
  };
};

const currentClient = () => createStreamSlotsClient({ baseUrl: getApiBaseUrl(), getToken: () => token });

const desktopStreamSlot = createDesktopStreamSlot({
  client: {
    startStream: (request) => currentClient().startStream(request),
    heartbeat: (streamId) => currentClient().heartbeat(streamId),
    stopStream: (streamId) => currentClient().stopStream(streamId),
  },
  getProfileId: () => profileStore.getSnapshot().activeId,
  closePlayback: () => closeHandler?.(),
});

export const desktopStreamSlotGate = desktopStreamSlot.gate;
export const acquireDesktopStreamSlot = desktopStreamSlot.acquire;
export const releaseDesktopStreamSlot = desktopStreamSlot.release;
