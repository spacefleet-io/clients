// PAR-TV-10: the remote's play and pause key pauses or resumes the music from every screen, and its next and previous
// (or fast-forward and rewind) keys go to the next or previous song. The Siri Remote's play and pause button arrives as
// the same `playPause` event. On Android the player's media session answers those keys itself (see `tvRemoteAction`).
import { Platform, useTVEventHandler } from "react-native";
import { AudioPlayback, showsPause } from "@space/mobile-audio-playback";
import { scopeLogger } from "@space/mobile-shell/logger";
import { tvRemoteAction, type TvRemoteAction } from "./tvModel";

const log = scopeLogger("parrot.tv.remote");

const run = async (action: TvRemoteAction) => {
  if (action === "next") return AudioPlayback.next();
  if (action === "previous") return AudioPlayback.previous();
  const state = await AudioPlayback.getState();
  return showsPause(state) ? AudioPlayback.pause() : AudioPlayback.play();
};

export const useTvRemoteKeys = (): void => {
  useTVEventHandler((event) => {
    const action = tvRemoteAction(event, Platform.OS);
    if (!action) return;
    log.info("key", { action, eventType: event.eventType });
    run(action).catch((error: unknown) => log.warn("key_failed", { action, message: error instanceof Error ? error.message : String(error) }));
  });
};
