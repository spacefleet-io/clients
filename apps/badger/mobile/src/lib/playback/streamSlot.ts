/**
 * The account's stream limit on the phone (ACCT-STREAM-01..04): one `StreamSlotGate` for the whole app, shared by the
 * player screen (kind `play`) and the cast screen (kind `cast`), so switching from one to the other hands the same
 * place over instead of asking twice. The question and the taken-over notice are native alerts drawn from
 * `@space/stream-slots` (`bindStreamSlotAlerts`), in the app's language.
 *
 * - `acquireStream(...)` before a streamed source starts; a download played from disk never asks (ACCT-STREAM-03).
 * - `onStreamTakenOver(listener)`: another device took the place over; the listening screen stops and closes.
 * - `streamSlots.release(owner)` when the screen closes.
 */
import { Alert } from "react-native";
import { getApiBaseUrl } from "@space/shared/api";
import { getCurrentLanguage } from "@space/mobile-shell/i18n";
import {
  StreamSlotGate,
  bindStreamSlotAlerts,
  createStreamSlotsClient,
  type StreamDevice,
  type StreamKind,
} from "@space/stream-slots";
import { getViewingScope } from "../profiles/activeViewingScope";

/** The screen that holds the place: the closing player must not free the place the cast screen just took. */
export type StreamOwner = "player" | "cast";

const log = (event: string, fields: Record<string, unknown>) => console.warn(event, JSON.stringify(fields));

let sessionToken: string | null = null;
const takenOverListeners = new Set<(by: StreamDevice) => void>();

export const streamSlots = new StreamSlotGate({
  client: createStreamSlotsClient({ baseUrl: getApiBaseUrl, getToken: () => sessionToken }),
  app: "badger",
  getProfileId: () => getViewingScope().profileId,
  onTakenOver: (by) => {
    for (const listener of [...takenOverListeners]) listener(by);
  },
  onError: (error) => log("stream_slot.error", { error: String(error) }),
  log,
});

bindStreamSlotAlerts(streamSlots, { alert: Alert.alert, language: getCurrentLanguage, log });

/**
 * Asks for a place before a playback starts. `"play"`: start it. `"cancel"`: the user chose Cancel at "Already playing
 * on {device}. Play here instead?": close the screen, nothing else changes. A download played from disk never asks.
 */
export const acquireStream = (request: { token: string; kind: StreamKind; owner: StreamOwner; offline: boolean }): Promise<"play" | "cancel"> => {
  if (request.offline) {
    log("stream_slot.offline_skip", { kind: request.kind, owner: request.owner });
    return Promise.resolve("play");
  }
  sessionToken = request.token;
  return streamSlots.acquire({ kind: request.kind, owner: request.owner });
};

export const onStreamTakenOver = (listener: (by: StreamDevice) => void): (() => void) => {
  takenOverListeners.add(listener);
  return () => {
    takenOverListeners.delete(listener);
  };
};
