/**
 * Keeps the TV app reachable for "Play on TV" (UX-TV-02) while it is signed in and running: it announces itself to the
 * account's peer relay as a `tv` peer (the API names it with the device name given at pairing), listens on the relay's
 * stream and runs the receiver (`playOnTvReceiver.ts`). The app has to be running: Android TV and Apple TV give a
 * React Native app no background service, so a TV whose app is closed drops out of the phone's list ~45 s later.
 */
import { useEffect, useRef } from "react";
import { StackActions } from "@react-navigation/native";
import { useAuth } from "../../store/auth";
import { useLibraryActions } from "../../store/library";
import { createAppRelay } from "../../lib/playOnTv/appRelay";
import { currentRemotePlayer, onRemotePlayerEvent } from "../../lib/playOnTv/playerLink";
import type { StartCommand } from "../../lib/playOnTv/protocol";
import { getLastPlayedEpisodeId } from "../../lib/resume";
import { playEpisode, uploadedEpisodeKeys } from "../../lib/playback/episodeSelection";
import { navigationRef } from "../../navigation/AppNavigator";
import { createTvReceiver, type StartOutcome } from "./playOnTvReceiver";

/** Presence heartbeat: the API forgets a peer 45 s after its last announcement. */
const PRESENCE_EVERY_MS = 20_000;

const log = (event: string, data: Record<string, unknown> = {}) => console.info(event, JSON.stringify(data));

export const usePlayOnTvReceiver = (enabled: boolean): void => {
  const { token } = useAuth();
  const { getMediaDetails } = useLibraryActions();
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const detailsRef = useRef(getMediaDetails);
  detailsRef.current = getMediaDetails;

  useEffect(() => {
    if (!enabled || !token) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    const startTitle = async (command: StartCommand): Promise<StartOutcome> => {
      const details = await detailsRef.current(command.mediaId).catch(() => null);
      if (!details) return "media_not_found";
      let episodeId = command.episodeId;
      if (details.type === "tv") {
        if (episodeId && !details.episodes.some((episode) => episode.id === episodeId)) return "media_not_found";
        // No episode named: the one the TV's own Play button would start (last played, else the first with files).
        if (!episodeId) episodeId = playEpisode(details, await getLastPlayedEpisodeId(command.mediaId), uploadedEpisodeKeys(details))?.id ?? null;
        if (!episodeId) return "media_not_found";
      } else {
        episodeId = null;
      }
      if (!navigationRef.isReady()) return "start_failed";
      const params = {
        mediaId: command.mediaId,
        episodeId,
        backdropPath: details.backdropPath ?? null,
        posterPath: details.posterPath ?? null,
        remoteStart: { positionSeconds: command.positionSeconds, tracks: command.tracks },
      };
      const onPlayer = navigationRef.getCurrentRoute()?.name === "Player";
      log("tv.cast.navigate", { replace: onPlayer, episode: episodeId !== null, positionSeconds: Math.round(command.positionSeconds) });
      if (onPlayer) navigationRef.dispatch(StackActions.replace("Player", params));
      else navigationRef.navigate("Player", params);
      return "ok";
    };

    void (async () => {
      const relay = await createAppRelay("tv", () => tokenRef.current);
      if (!relay || cancelled) return;
      const { transport, channel } = relay;
      const receiver = createTvReceiver({ channel, startTitle, currentPlayer: currentRemotePlayer });

      const announce = async () => {
        const result = await transport.register("tv");
        log("tv.cast.presence", { result });
      };
      await announce();
      if (cancelled) return;
      const presence = setInterval(() => void announce(), PRESENCE_EVERY_MS);
      const stopListening = channel.listen(
        (fromPeerId, body) => void receiver.handle(fromPeerId, body),
        (status) => log("tv.cast.stream", { status }),
      );
      const stopLink = onRemotePlayerEvent(receiver.onPlayerEvent);
      // The peer id is a random per-launch id (no title, no account data): the e2e phone client finds this TV by it.
      log("tv.cast.listening", { peerId: transport.peerId });
      cleanup = () => {
        clearInterval(presence);
        stopListening();
        stopLink();
        log("tv.cast.stopped", {});
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
      cleanup = null;
    };
  }, [enabled, token]);
};
