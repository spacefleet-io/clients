/**
 * The account's stream limit on Parrot desktop (ACCT-STREAM-01..04), on the main side: the shared `StreamSlotGate`
 * runs here, next to the session token and the kept songs, so the window never holds the token. The window asks
 * before each song starts (`acquire(trackId)`), draws the gate's state (the question, the taken-over notice) from
 * `onState`, and answers through `answer` / `dismiss`.
 *
 * - A song kept on this computer plays from its kept copy and never asks (ACCT-STREAM-03).
 * - Another song starting while the place is held reuses it without a request.
 * - `release()` when the music stops (queue over, stop, sign-out, quit) gives the place back (ACCT-STREAM-04).
 */
import {
  StreamSlotGate,
  createStreamSlotsClient,
  type StreamSlotAnswer,
  type StreamSlotGateState,
} from "@space/stream-slots";

export type DesktopStreamSlots = {
  acquire: (trackId: string) => Promise<"play" | "cancel">;
  answer: (answer: StreamSlotAnswer) => void;
  dismiss: () => void;
  release: () => Promise<void>;
  state: () => StreamSlotGateState;
};

export const createDesktopStreamSlots = (deps: {
  apiBaseUrl: string;
  token: () => string | null;
  /** The profile playback names (STOR-BW-11); null = the account's main profile. */
  profileId: () => Promise<string | null>;
  isKept: (trackId: string) => boolean;
  onState: (state: StreamSlotGateState) => void;
  log: (line: string) => void;
  fetch?: typeof fetch;
}): DesktopStreamSlots => {
  let profileId: string | null = null;
  const log = (event: string, fields: Record<string, unknown>) => deps.log(`[stream] ${event} ${JSON.stringify(fields)}`);
  const gate = new StreamSlotGate({
    client: createStreamSlotsClient({ baseUrl: deps.apiBaseUrl, getToken: deps.token, fetch: deps.fetch }),
    app: "parrot",
    getProfileId: () => profileId,
    onError: (error) => log("error", { error: String(error) }),
    log,
  });
  gate.subscribe(() => deps.onState(gate.getState()));
  return {
    acquire: async (trackId) => {
      if (deps.isKept(trackId)) {
        log("kept_skip", { trackId });
        return "play";
      }
      profileId = await deps.profileId().catch(() => null);
      return gate.acquire({ kind: "play", owner: "player" });
    },
    answer: (answer) => gate.answer(answer),
    dismiss: () => gate.dismiss(),
    release: () => gate.release(),
    state: () => gate.getState(),
  };
};
