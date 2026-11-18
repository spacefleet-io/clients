import type { SubtitleTrack } from "./types";

/** The two native calls a subtitle pick needs (a subset of `MpvControl`). */
export type SubtitlePickPlayer = {
  removeAllSubtitles: () => Promise<unknown>;
  addSubtitle: (url: string, language: string | null, title: string | null) => Promise<unknown>;
};

export type SubtitlePickArgs = {
  /** Index into `subtitleTracks` the user picked; `-1` = Off. */
  idx: number;
  /** Index showing before the pick; `-1` = Off. */
  previousIdx: number;
  subtitleTracks: SubtitleTrack[];
  /** Sidecar URL for a track (`/playback/object/<key>` on the loopback proxy). */
  urlFor: (sub: SubtitleTrack) => string;
};

export type SubtitlePickEffects = {
  /** The subtitle menu's selected row. */
  setActiveIdx: (idx: number) => void;
  /** Shows the "Subtitles couldn't load" notice. */
  showLoadFailed: () => void;
  /** Fires once the pick actually took effect (the owner remembers it, PLAY-TRACK-04). */
  onPicked?: (track: SubtitleTrack | null) => void;
};

export type SubtitlePickOutcome = "ok" | "load_failed";

/**
 * Applies a subtitle the user picked in the controls. The menu shows the pick at once; when mpv cannot load the
 * file (native `addSubtitle` rejects, e.g. `subtitle_load_failed` after a proxy 502), the notice is shown, the
 * previous subtitle is put back in mpv and in the menu, and the failed pick is not remembered (PLAY-TRACK-06).
 */
export const applySubtitlePick = async (
  player: SubtitlePickPlayer,
  { idx, previousIdx, subtitleTracks, urlFor }: SubtitlePickArgs,
  effects: SubtitlePickEffects,
): Promise<SubtitlePickOutcome> => {
  const sub = idx >= 0 ? subtitleTracks[idx] ?? null : null;
  effects.setActiveIdx(idx);
  try {
    await player.removeAllSubtitles();
  } catch (e) {
    // `sub-add … select` still replaces the shown subtitle; only a failed load below counts as a failed pick.
    console.warn("[controls] subtitle.remove_failed", JSON.stringify({ idx, error: String(e) }));
  }
  if (!sub) {
    effects.onPicked?.(null);
    return "ok";
  }
  const url = urlFor(sub);
  try {
    await player.addSubtitle(url, sub.language ?? null, sub.label ?? null);
    console.info("[controls] subtitle.picked", JSON.stringify({ idx, id: sub.id, url }));
    effects.onPicked?.(sub);
    return "ok";
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    console.warn(
      "[controls] subtitle.load_failed",
      JSON.stringify({ idx, previousIdx, id: sub.id, url, code: code ?? null, error: String(e) }),
    );
  }
  effects.showLoadFailed();
  effects.setActiveIdx(previousIdx);
  const previous = previousIdx >= 0 ? subtitleTracks[previousIdx] ?? null : null;
  if (previous) {
    try {
      await player.addSubtitle(urlFor(previous), previous.language ?? null, previous.label ?? null);
      console.info("[controls] subtitle.restored", JSON.stringify({ idx: previousIdx, id: previous.id }));
    } catch (e) {
      // The previous file failed too: nothing is showing, so the menu says Off rather than claim a dead track.
      console.warn("[controls] subtitle.restore_failed", JSON.stringify({ idx: previousIdx, error: String(e) }));
      effects.setActiveIdx(-1);
    }
  }
  return "load_failed";
};
