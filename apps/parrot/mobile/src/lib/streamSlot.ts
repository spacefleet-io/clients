/**
 * The account's stream limit on the phone (ACCT-STREAM-01..04): one `StreamSlotGate` for the whole app. Streamed music
 * asks for a place before it starts; songs kept on the phone, or played with no connection, never ask
 * (ACCT-STREAM-03). The question and the taken-over notice are native alerts drawn from `@space/stream-slots`
 * (`bindStreamSlotAlerts`), in the app's language. Another device taking the place over stops the music (the queue is
 * cleared, so playing again goes through the question again); the music reaching its end gives the place back.
 */
import { Alert } from "react-native";
import { getApiBaseUrl } from "@space/shared/api";
import { getCurrentLanguage } from "@space/mobile-shell/i18n";
import { AudioPlayback } from "@space/mobile-audio-playback";
import { StreamSlotGate, bindStreamSlotAlerts, createStreamSlotsClient } from "@space/stream-slots";
import { activeProfileId } from "./activeProfile";

const log = (event: string, fields: Record<string, unknown>) => console.log(`parrot.${event}`, JSON.stringify(fields));

let sessionToken: string | null = null;

export const streamSlots = new StreamSlotGate({
  client: createStreamSlotsClient({ baseUrl: getApiBaseUrl, getToken: () => sessionToken }),
  app: "parrot",
  getProfileId: () => activeProfileId(),
  onTakenOver: (by) => {
    log("stream_slot.stop_music", { by });
    void AudioPlayback.stop().catch(() => undefined);
  },
  onError: (error) => log("stream_slot.error", { error: String(error) }),
  log,
});

bindStreamSlotAlerts(streamSlots, { alert: Alert.alert, language: getCurrentLanguage, log });

let endWatch: { remove: () => void } | null = null;

/**
 * Asks for a place before streamed music starts. `"play"`: start it. `"cancel"`: the user chose Cancel at "Already
 * playing on {device}. Play here instead?": the music stays as it was. Only kept songs (or no connection) never ask.
 */
export const acquireStream = async (request: { token: string; streamed: boolean }): Promise<"play" | "cancel"> => {
  if (!request.streamed) {
    log("stream_slot.not_streamed_skip", {});
    return "play";
  }
  sessionToken = request.token;
  endWatch ??= AudioPlayback.onState((state) => {
    if (state.state === "ended" && streamSlots.holding) {
      log("stream_slot.music_ended", {});
      void streamSlots.release();
    }
  });
  return streamSlots.acquire({ kind: "play", owner: "music" });
};

/** The music stopped for good (sign-out): give the place back. */
export const releaseStream = () => streamSlots.release();
