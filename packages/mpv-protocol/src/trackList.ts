/**
 * Track-list helpers shared between desktop-mpv-playback (renderer) and
 * the main-process external-mpv driver. The defensive `MpvTrack` shape
 * mirrors what mpv emits over JSON IPC `get_property track-list`.
 *
 * Relocated from @space/desktop-mpv-playback (externalMpvController.ts)
 * in Phase 1b. `findExternalSubtitle` (the divergence-resolving consolidated
 * matcher) lands in a follow-up commit.
 */

export type MpvTrack = {
  id?: number;
  type?: string;
  "external-filename"?: string;
  lang?: string;
  title?: string;
  external?: boolean;
  selected?: boolean;
  /** HLS variant BANDWIDTH of a video track (mpv `track-list/N/hls-bitrate`). */
  "hls-bitrate"?: number;
};

export const buildTrackSignature = (
  list: ReadonlyArray<MpvTrack>,
): string =>
  list
    .map((track = {} as MpvTrack) =>
      [
        track.id ?? "",
        track.type ?? "",
        track.lang ?? "",
        track.external ? "ext" : "int",
        track.selected ? "sel" : "",
      ]
        .filter(Boolean)
        .join(":"),
    )
    .join("|");

export const hasUsableExternalTrackState = (
  list: ReadonlyArray<MpvTrack> | null | undefined,
  timePos: number | null,
  stableForMs: number,
): boolean => {
  const tracks = Array.isArray(list) ? list : [];
  if (tracks.length === 0) return false;
  if (stableForMs >= 450) return true;
  return typeof timePos === "number" && Number.isFinite(timePos) && timePos >= 0;
};

/**
 * Query shape for `findExternalSubtitle`.
 *
 * `url` is the external subtitle URL the renderer expects to be in the
 * track list (e.g. `/cache/abc.srt`). It may be undefined when the caller
 * has nothing to match against — the "off" path — in which case the
 * matcher MUST NOT silently match an entry without an `external-filename`
 * field (see fixture-7 in the corpus).
 *
 * `expectedLang` + `expectedTitle` are the fields the renderer expects
 * mpv to have populated when sf.lua sub-added the track.
 */
export type ExternalSubtitleQuery = {
  url: string | undefined;
  expectedLang: string;
  expectedTitle: string;
};

/**
 * Find the first external subtitle in `tracks` that matches `query`.
 *
 * Consolidated matcher that replaces the duplicated logic at
 * `useMpvPlaybackEngine.ts:1505` and `sf.lua:13` (`subtitle_exists`).
 * Resolves the Phase 1a parity divergences as decided by the plan:
 *
 *   1. **Lang-tightener parity (fixture-3).** The non-url branch requires
 *      BOTH `lang === expectedLang` AND `title === expectedTitle`. The
 *      original Lua `subtitle_exists` permits title-alone matches when its
 *      lang param is nil, which would silently flip default-subtitle
 *      selection for tracks whose title coincidentally matches under a
 *      different language. JS semantics win — title alone is not enough.
 *
 *   2. **Undefined-URL safety (fixture-7).** The url branch requires
 *      `url !== undefined && externalFilename === url`. The original JS
 *      rule compared `t["external-filename"] === url`, which evaluates
 *      `undefined === undefined` to true and silently matches the first
 *      `external-filename`-less track when the caller has no URL. Callers
 *      with no URL must use a separate "off" code path — this helper
 *      refuses to guess.
 *
 * Returns the matched track or undefined.
 */
export const findExternalSubtitle = (
  tracks: ReadonlyArray<MpvTrack>,
  query: ExternalSubtitleQuery,
): MpvTrack | undefined => {
  const { url, expectedLang, expectedTitle } = query;
  return tracks.find((track) => {
    if (!track || track.type !== "sub") return false;
    const externalFilename = track["external-filename"];
    if (url !== undefined && externalFilename === url) {
      return true;
    }
    return track.lang === expectedLang && track.title === expectedTitle;
  });
};
