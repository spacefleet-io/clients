import { sortVariantsBestToWorst } from "@space/playback-abr";
import type { AudioTrack, SubtitleTrack, VideoFormat } from "./types";

/** One row of a player picker sheet (audio / subtitles). */
export type TrackRow = {
  key: string;
  testID?: string;
  title: string;
  subtitle?: string;
  selected: boolean;
  /** Shown greyed out and can't be picked (a picture subtitle without an OCR twin under direct rendering, PLAY-TRACK-05). */
  disabled?: boolean;
  onPress: () => void;
};

type TrackLike = { id: string; label?: string | null; language?: string | null };

/** Short lowercase labels ("fr", "en") read as language codes: show them upper-cased. */
export const titleCase = (s?: string | null): string => {
  if (!s) return "";
  if (s.length <= 4 && s === s.toLowerCase()) return s.toUpperCase();
  return s;
};

const trackRow = (testPrefix: string, t: TrackLike, i: number, activeIdx: number, trackFallback: (n: number) => string, select: (idx: number) => void): TrackRow => ({
  key: t.id,
  testID: `${testPrefix}-${i}`,
  title: titleCase(t.label) || t.language?.toUpperCase() || trackFallback(i + 1),
  subtitle: t.language?.toUpperCase(),
  selected: i === activeIdx,
  onPress: () => select(i),
});

/** The audio menu: one row per track, never an "Off" row (a file always plays some audio). */
export const buildAudioRows = (
  tracks: AudioTrack[],
  activeIdx: number,
  trackFallback: (n: number) => string,
  select: (idx: number) => void,
): TrackRow[] => tracks.map((a, i) => trackRow("player-audio-option", a, i, activeIdx, trackFallback, select));

/**
 * The quality menu: Auto first, then one row per version, highest quality first (the order of the title page's
 * Qualities & tracks tab, UX-TV-07). The library hands versions over in upload order (4K after 360p), so the menu sorts
 * them with the shared ladder order (`sortVariantsBestToWorst`, the web player's and the ABR's order). A second version
 * of one height gets a codec-suffixed testID.
 */
export const buildQualityRows = (
  videos: readonly VideoFormat[],
  activeVideoId: string | null | undefined,
  qualityMode: "auto" | "manual",
  autoLabel: string,
  select: (id: string | "auto") => void,
): TrackRow[] => {
  const seen = new Set<string>();
  const sorted = sortVariantsBestToWorst(videos);
  return [
    {
      key: "__auto__",
      testID: "player-quality-option-auto",
      title: autoLabel,
      subtitle: qualityMode === "auto" ? (videos.find((v) => v.id === activeVideoId)?.quality ?? undefined) : undefined,
      selected: qualityMode === "auto",
      onPress: () => select("auto"),
    },
    ...sorted.map((v) => {
      const dupe = seen.has(v.quality);
      seen.add(v.quality);
      return {
        key: v.id,
        testID: `player-quality-option-${dupe ? `${v.quality}-${v.codec}` : v.quality}`,
        title: v.quality,
        subtitle: v.codec,
        selected: qualityMode === "manual" && v.id === activeVideoId,
        onPress: () => select(v.id),
      };
    }),
  ];
};

/**
 * The "Get more subtitles…" row, last in the subtitle menu (PLAY-SUBGET-02). Offline it stays, greyed out, with the
 * reason as its second line (PLAY-SUBGET-12).
 */
export type SubtitleGetMoreRow = {
  title: string;
  /** Why it can't be picked right now ("Needs an internet connection"), or null when it can. */
  unavailableReason: string | null;
  onPress: () => void;
};

/**
 * "Try another version" (PLAY-SUBGET-07): after "Get more subtitles…" while the subtitle on is one the app fetched
 * (the owner says which, `isFetched`, from the track's `source`). Offline it stays, greyed out, with the reason.
 */
export type SubtitleTryAnotherRow = {
  title: string;
  /** The track was fetched by the app (`isFetchedSubtitleSource(track.source)`), so another version of it exists. */
  isFetched: (track: SubtitleTrack) => boolean;
  /** Why it can't be picked right now ("Needs an internet connection"), or null when it can. */
  unavailableReason: string | null;
  onPress: (track: SubtitleTrack) => void;
};

/**
 * The subtitle menu: the translated "Off" row first (selecting index -1 removes the subtitles), then one row per track,
 * then "Get more subtitles…" when the owner passes it (PLAY-SUBGET-02, -24), then "Add a subtitle file…" when the owner
 * passes it (PLAY-SUBGET-23, phone only), then "Try another version" when the subtitle on is a fetched one
 * (PLAY-SUBGET-07).
 * `unplayable` tracks stay listed but disabled (PLAY-TRACK-05: picture tracks without an OCR twin under direct rendering).
 */
export const buildSubtitleRows = (
  tracks: SubtitleTrack[],
  activeIdx: number,
  offLabel: string,
  trackFallback: (n: number) => string,
  select: (idx: number) => void,
  unplayable: (track: SubtitleTrack) => boolean,
  getMore?: SubtitleGetMoreRow | null,
  tryAnother?: SubtitleTryAnotherRow | null,
  addFile?: SubtitleGetMoreRow | null,
): TrackRow[] => {
  const active = activeIdx >= 0 ? tracks[activeIdx] : undefined;
  return [
    { key: "__off__", testID: "player-subtitle-option-off", title: offLabel, subtitle: undefined, selected: activeIdx === -1, onPress: () => select(-1) },
    ...tracks.map((s, i) => ({ ...trackRow("player-subtitle-option", s, i, activeIdx, trackFallback, select), disabled: unplayable(s) })),
    ...(getMore
      ? [
          {
            key: "__get_more__",
            testID: "player-subtitle-option-get-more",
            title: getMore.title,
            subtitle: getMore.unavailableReason ?? undefined,
            selected: false,
            disabled: getMore.unavailableReason !== null,
            onPress: getMore.onPress,
          },
        ]
      : []),
    ...(addFile
      ? [
          {
            key: "__add_file__",
            testID: "player-subtitle-option-add-file",
            title: addFile.title,
            subtitle: addFile.unavailableReason ?? undefined,
            selected: false,
            disabled: addFile.unavailableReason !== null,
            onPress: addFile.onPress,
          },
        ]
      : []),
    ...(tryAnother && active && tryAnother.isFetched(active)
      ? [
          {
            key: "__try_another__",
            testID: "player-subtitle-option-try-another",
            title: tryAnother.title,
            subtitle: tryAnother.unavailableReason ?? undefined,
            selected: false,
            disabled: tryAnother.unavailableReason !== null,
            onPress: () => tryAnother.onPress(active),
          },
        ]
      : []),
  ];
};

/** What a screen reader says for a picker row: the human text on it ("English 5.1, EN"), never its testID (UX-A11Y-04). */
export const pickerRowAccessibilityLabel = (row: Pick<TrackRow, "title" | "subtitle">): string =>
  row.subtitle ? `${row.title}, ${row.subtitle}` : row.title;

/** Visible title of a chapter row ("#2: Opening", or "#2" for a chapter without a name); spoken with its start time. */
export const chapterRowTitle = (index: number, title: string): string => (title.trim() ? `#${index + 1}: ${title}` : `#${index + 1}`);

/**
 * Where a TV track menu scrolls on opening so its selected row, which takes the focus, is on screen (UX-TV-01, #2754):
 * `null` while the row already shows in the menu's first screenful (or the menu has no height yet), else the offset
 * that puts the row in the middle. The native scroll-to-focus runs before the rows are laid out, so it never moves.
 */
export const selectedRowScrollY = (row: { y: number; height: number }, viewportHeight: number): number | null => {
  if (viewportHeight <= 0 || row.y + row.height <= viewportHeight) return null;
  return Math.max(0, row.y - (viewportHeight - row.height) / 2);
};
