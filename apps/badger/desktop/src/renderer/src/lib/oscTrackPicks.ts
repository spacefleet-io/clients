// Tracks the user picked in the mpv OSC, carried across reloads.
//
// @bugfix @regression-proof issue #25 P18 (confirm run, S1 c066/x018, S3
// c010/c042): sf-select.lua set `aid` straight in mpv, so the renderer never
// learnt the pick. An ABR downshift ~1 s later reloaded with `loadfile …
// replace` and no `aid`, mpv fell back to its default track, and the user
// heard English again after picking French. sf-select.lua now reports every
// pick on the `sf-track-picked` script-message; this holder keeps it per file
// and hands it to every reload's per-load options.
//
// Audio: the HLS session lists the audio renditions in the same order on every
// reload of a file (createHlsSession maps `audioOptions` in order), so the mpv
// `aid` stays valid across reloads and is carried as `aid=<n>`.
//
// Subtitles: streamed subtitles are sub-added by sf.lua AFTER the load, so a
// numeric `sid` on the loadfile would point at nothing (or the wrong track).
// A subtitle pick that maps to one of the app's subtitle options flows back
// into `selectedSubtitleId` instead (the reload's metadata payload then
// sub-adds it with the "select" flag). Only a pick the app cannot map
// (embedded tracks of an offline file) is carried as `sid=<n>`.

import {
  findExternalSubtitle,
  LUA_OUTBOUND_CHANNELS,
  type LoadfileTrackSelection,
  type MpvTrack,
} from "@space/mpv-protocol";
import { formatPlayerTrackLabel } from "@/lib/playerTrackLabel";
import type { SubtitleOption } from "@/lib/playbackTypes";
import type { TrackPrefsPatch } from "@space/shared/trackPrefs";

export type OscTrackProperty = "aid" | "sid";
export type OscTrackPick = { property: OscTrackProperty; value: LoadfileTrackSelection };
/**
 * A video (quality) pick. Not carried as a raw `vid`: the engine maps it to
 * its format and switches to it as a manual pick (issue #25 P19).
 */
export type OscVideoPick = { property: "vid"; value: LoadfileTrackSelection };

/** Parse one forwarded mpv message; null unless it is a valid track pick. */
export const parseTrackPickedMessage = (msg: {
  type: string;
  name?: unknown;
  args?: unknown;
}): OscTrackPick | OscVideoPick | null => {
  if (msg.type !== "script_message" || msg.name !== LUA_OUTBOUND_CHANNELS.TRACK_PICKED) return null;
  const args = Array.isArray(msg.args) ? msg.args : [];
  const [property, raw] = args;
  if (property !== "aid" && property !== "sid" && property !== "vid") return null;
  if (raw === "no") return { property, value: "no" };
  const id = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(id) || id <= 0) return null;
  return { property, value: id };
};

/**
 * The app subtitle option a picked mpv `sid` corresponds to: "off" for "no",
 * the option whose formatted title + language match the picked track (same
 * formatter the metadata payload uses), or null when nothing matches.
 */
export const resolvePickedSubtitleOptionId = (params: {
  sid: LoadfileTrackSelection;
  trackList: ReadonlyArray<MpvTrack>;
  subtitleOptions: ReadonlyArray<SubtitleOption>;
}): string | null => {
  if (params.sid === "no") return "off";
  const track = params.trackList.find((entry) => entry?.type === "sub" && entry.id === params.sid);
  if (!track) return null;
  const match = params.subtitleOptions.find((option) => {
    if (option.id === "off") return false;
    const expectedTitle = formatPlayerTrackLabel(option.language, option.label, "Subtitle");
    const expectedLang = option.language || "und";
    return findExternalSubtitle([track], { url: undefined, expectedLang, expectedTitle }) !== undefined;
  });
  return match?.id ?? null;
};

export type OscTrackReloadOptions = {
  audioTrack: LoadfileTrackSelection | null;
  subtitleTrack: LoadfileTrackSelection | null;
};

export class OscTrackPicks {
  private fileId: string | null = null;
  private audio: LoadfileTrackSelection | null = null;
  private subtitle: LoadfileTrackSelection | null = null;

  /** Record a pick for `fileId`; a pick for another file drops the old ones. */
  record(fileId: string | null, pick: OscTrackPick): void {
    if (fileId === null) return;
    if (fileId !== this.fileId) this.reset(fileId);
    if (pick.property === "aid") this.audio = pick.value;
    else this.subtitle = pick.value;
  }

  /**
   * The subtitle pick now lives in the app's `selectedSubtitleId`, which the
   * reload's metadata payload applies; stop carrying the raw `sid`.
   */
  subtitleMappedToOption(fileId: string | null): void {
    if (fileId !== null && fileId === this.fileId) this.subtitle = null;
  }

  /** The user chose audio in the app: the app's choice wins over the OSC pick. */
  clearAudio(): void {
    this.audio = null;
  }

  /** The user chose a subtitle in the app: stop carrying a raw OSC `sid`. */
  clearSubtitle(): void {
    this.subtitle = null;
  }

  /** Drop every pick (player closed, or a new file). */
  reset(fileId: string | null = null): void {
    this.fileId = fileId;
    this.audio = null;
    this.subtitle = null;
  }

  /** Per-load track options for a (re)load of `fileId`. */
  reloadOptions(fileId: string | null): OscTrackReloadOptions {
    if (fileId === null || fileId !== this.fileId) return { audioTrack: null, subtitleTrack: null };
    return { audioTrack: this.audio, subtitleTrack: this.subtitle };
  }

  /**
   * Whether any pick is carried for `fileId` right now. A reload re-checks
   * the live tracks against THIS, not its pre-load snapshot: a pick made
   * while the loadfile was in flight is not in the snapshot.
   * @bugfix @regression-proof issue #25 P3 (ultimate run S2 x007)
   */
  hasPicks(fileId: string | null): boolean {
    const { audioTrack, subtitleTrack } = this.reloadOptions(fileId);
    return audioTrack !== null || subtitleTrack !== null;
  }

  /**
   * The carried picks mpv did NOT apply on a reload of `fileId`, given its
   * live `aid` / `sid` read after the load (JSON IPC reports "no" as false).
   * An unreadable live value is skipped: nothing to compare against.
   *
   * @bugfix @regression-proof issue #25 P18-aid2 (ultimate run S1 c061): the
   * ABR reload carried `aid=2` on its loadfile and mpv logged the option, yet
   * selected `--aid=1` and kept it; the pick had to be set again after load.
   */
  unhonored(fileId: string | null, live: { aid: unknown; sid: unknown }): OscTrackPick[] {
    const { audioTrack, subtitleTrack } = this.reloadOptions(fileId);
    const picks: OscTrackPick[] = [];
    for (const [property, picked, raw] of [
      ["aid", audioTrack, live.aid],
      ["sid", subtitleTrack, live.sid],
    ] as const) {
      if (picked === null) continue;
      const current = raw === false || raw === "no" ? "no" : typeof raw === "number" ? raw : null;
      if (current !== null && current !== picked) picks.push({ property, value: picked });
    }
    return picks;
  }
}

/**
 * The synced per-media track preference (PLAY-TRACK-04) an OSC pick stands for,
 * or null when the pick says nothing durable (audio has no "off"; a track whose
 * language mpv does not know). `subtitleOptionId` is the app option the sid
 * mapped to (`resolvePickedSubtitleOptionId`), null for an unmapped track.
 */
export const trackPrefsPatchForPick = (params: {
  pick: OscTrackPick;
  trackList: ReadonlyArray<MpvTrack>;
  subtitleOptions: ReadonlyArray<SubtitleOption>;
  subtitleOptionId: string | null;
}): TrackPrefsPatch | null => {
  const { pick, trackList, subtitleOptions, subtitleOptionId } = params;
  if (pick.value === "no") return pick.property === "sid" ? { subtitle: "off" } : null;
  const track = trackList.find((entry) => entry?.type === (pick.property === "aid" ? "audio" : "sub") && entry.id === pick.value);
  if (pick.property === "aid") return track?.lang ? { audioLanguage: track.lang } : null;
  const option = subtitleOptionId && subtitleOptionId !== "off" ? subtitleOptions.find((entry) => entry.id === subtitleOptionId) : undefined;
  if (option) {
    return { subtitle: { language: option.language, ...(option.format ? { format: option.format } : {}) } };
  }
  return track?.lang ? { subtitle: { language: track.lang } } : null;
};
