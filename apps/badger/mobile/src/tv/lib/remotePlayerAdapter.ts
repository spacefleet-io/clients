/**
 * How the TV's player screen carries out "Play on TV" commands from the phone and describes itself back (UX-TV-02).
 * Pure: the screen passes the controls handle, the native player calls and what it knows; the tests pass fakes.
 * Track picks go through the controls' own pickers, so a pick from the phone is shown in the TV's menus and remembered
 * like a pick on the TV (PLAY-TRACK-04); seeks of ±N s go through the controls' step seek, with its on-screen toast.
 */
import type { RemotePlayer } from "../../lib/playOnTv/playerLink";
import type { TvPhase, TvState, TvTrack } from "../../lib/playOnTv/protocol";

export type RemoteCommandForPlayer = Parameters<RemotePlayer["apply"]>[0];

/** The slice of `PlayerControlsHandle` the remote needs. */
export type RemoteControls = {
  stepSeek: (direction: -1 | 1, seconds?: number) => void;
  selectAudio: (idx: number) => Promise<void>;
  selectSubtitle: (idx: number) => Promise<void>;
  trackState: () => { audioIdx: number; subtitleIdx: number };
};

/** The slice of `MpvControl` the remote needs. */
export type RemoteNativePlayer = {
  setPaused: (paused: boolean) => Promise<unknown>;
  seek: (seconds: number, mode: "absolute") => Promise<unknown>;
  seekRelative: (seconds: number, mode: null) => Promise<unknown>;
};

export type RemoteApplyDeps = {
  controls: RemoteControls | null;
  player: RemoteNativePlayer;
  audioTrackCount: number;
  subtitleTrackCount: number;
  /** Closes the player the way Back does (progress is saved on the way out). */
  close: () => void;
};

/** Carries out one command; resolves to an error code for the phone, or null. */
export const applyRemoteCommand = async (command: RemoteCommandForPlayer, deps: RemoteApplyDeps): Promise<string | null> => {
  switch (command.type) {
    case "pause":
      await deps.player.setPaused(true);
      return null;
    case "play":
      await deps.player.setPaused(false);
      return null;
    case "seekBy": {
      if (command.deltaSeconds === 0) return null;
      const direction = command.deltaSeconds < 0 ? -1 : 1;
      if (deps.controls) deps.controls.stepSeek(direction, Math.abs(command.deltaSeconds));
      else await deps.player.seekRelative(command.deltaSeconds, null);
      return null;
    }
    case "seekTo":
      await deps.player.seek(command.positionSeconds, "absolute");
      return null;
    case "setAudio":
      if (!deps.controls) return "not_ready";
      if (command.idx >= deps.audioTrackCount) return "no_such_track";
      await deps.controls.selectAudio(command.idx);
      return null;
    case "setSubtitle":
      if (!deps.controls) return "not_ready";
      if (command.idx >= deps.subtitleTrackCount) return "no_such_track";
      await deps.controls.selectSubtitle(command.idx);
      return null;
    case "stop":
      deps.close();
      return null;
  }
};

type TrackLike = { label?: string | null; language?: string | null };

export type TvStateInput = {
  mediaId: string;
  episodeId: string | null;
  title: string | null;
  failed: boolean;
  /** The latest native snapshot (null before the first poll). */
  snapshot: { position: number; duration: number; paused: boolean; voConfigured: boolean } | null;
  fallbackDurationSeconds: number;
  audioTracks: readonly TrackLike[];
  subtitleTracks: readonly TrackLike[];
  trackState: { audioIdx: number; subtitleIdx: number } | null;
};

const toTracks = (tracks: readonly TrackLike[]): TvTrack[] =>
  tracks.map((track, idx) => ({ idx, label: track.label?.trim() || null, language: track.language?.trim() || null }));

/** What the TV tells the phone about its player. */
export const buildTvState = (input: TvStateInput): TvState => {
  const snap = input.snapshot;
  const phase: TvPhase = input.failed ? "failed" : !snap?.voConfigured ? "loading" : snap.paused ? "paused" : "playing";
  const audioIdx = input.trackState && input.trackState.audioIdx >= 0 && input.trackState.audioIdx < input.audioTracks.length
    ? input.trackState.audioIdx
    : null;
  return {
    type: "state",
    phase,
    mediaId: input.mediaId,
    episodeId: input.episodeId,
    title: input.title,
    positionSeconds: Math.max(0, snap?.position ?? 0),
    durationSeconds: snap && snap.duration > 0 ? snap.duration : input.fallbackDurationSeconds,
    audioTracks: toTracks(input.audioTracks),
    subtitleTracks: toTracks(input.subtitleTracks),
    audioIdx,
    subtitleIdx: input.trackState?.subtitleIdx ?? -1,
    error: null,
  };
};
