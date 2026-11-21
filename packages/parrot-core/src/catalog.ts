// Pure rules over Parrot library rows, shared by the phone, the desktop and the web player: track order, which stored
// file of a track plays, and how a file's chunk rows become the byte-range layout the players read.
import type { TrackFileChunkRow } from "@space/parrot-library-db-definition";
import { formatClock } from "@space/shared/format";

export type { TrackFileChunkRow };

export type AlbumRow = {
  id: string;
  title: string;
  artistName: string;
  /** The album artist, whose page the name opens (PAR-NAV-05); null when the album has none. */
  artistId?: string | null;
  year: number | null;
  kind: string;
  trackCount: number;
  /** When the album first came into the library (ms since 1970), for the "Recently added" order. */
  addedAt: number;
  /** Its genre tag, for the library's Genre filter (PAR-LIB-06); absent on rows read by other queries. */
  genre?: string | null;
};

export type TrackRow = {
  id: string;
  albumId: string;
  disc: number;
  number: number | null;
  title: string;
  artistName: string;
  /** The song's artist, for the order of Home's "Your artists" (PAR-HOME-01); '' when it has none. */
  artistId?: string;
  durationMs: number | null;
  /**
   * For "Even out volume" (PAR-PLAY-03 item 2): ReplayGain 2.0 gain (dB) and peak (true peak when Parrot measured it, the
   * tag's sample peak otherwise); null or absent until measured.
   */
  gainDb?: number | null;
  peak?: number | null;
  albumGainDb?: number | null;
  albumPeak?: number | null;
};

export type TrackFileRow = {
  id: string;
  trackId: string;
  mime: string;
  lossless: boolean;
  bitrateKbps: number | null;
  sizeBytes: number;
  lightCopy: boolean;
  createdAt: number;
};

/** A stored file as a player reads it: plaintext bytes `[0, sizeBytes)` tiled by SFV1 chunk objects. */
export type ChunkedFile = {
  id: string;
  mime: string;
  sizeBytes: number;
  chunks: Array<Pick<TrackFileChunkRow, "objectKey" | "plainOffset" | "plainSize">>;
};

/** Album order: disc, then track number (unnumbered tracks last), then title. */
export const sortTracks = <T extends Pick<TrackRow, "disc" | "number" | "title">>(tracks: T[]): T[] =>
  [...tracks].sort(
    (a, b) =>
      a.disc - b.disc ||
      (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) ||
      a.title.localeCompare(b.title)
  );

/**
 * The file a track plays: the original, never a light copy while an original exists (PAR-FMT-01); lossless before
 * lossy, then the higher bitrate, then the oldest import. `canPlay` leaves out files the player cannot decode (the web
 * player asks the browser, PLAT-WEB-08), so another stored copy plays instead. Null when no file is left.
 */
export const pickPlayableFile = <T extends TrackFileRow>(files: T[], canPlay: (mime: string) => boolean = () => true): T | null => {
  const playable = files.filter((file) => canPlay(file.mime));
  const originals = playable.filter((file) => !file.lightCopy);
  const pool = originals.length > 0 ? originals : playable;
  const ranked = [...pool].sort(
    (a, b) =>
      Number(b.lossless) - Number(a.lossless) ||
      (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0) ||
      a.createdAt - b.createdAt
  );
  return ranked[0] ?? null;
};

/**
 * A stored file as the players read it. Throws `FILE_CHUNKS_INCOMPLETE` unless the chunks tile `[0, sizeBytes)`
 * exactly, so a broken library row fails here, not mid-song.
 */
export const toChunkedFile = (file: Pick<TrackFileRow, "id" | "mime" | "sizeBytes">, chunks: TrackFileChunkRow[]): ChunkedFile => {
  const ordered = [...chunks].sort((a, b) => a.plainOffset - b.plainOffset);
  let next = 0;
  for (const chunk of ordered) {
    if (chunk.plainOffset !== next || chunk.plainSize <= 0) throw new Error("FILE_CHUNKS_INCOMPLETE");
    next += chunk.plainSize;
  }
  if (next !== file.sizeBytes) throw new Error("FILE_CHUNKS_INCOMPLETE");
  return {
    id: file.id,
    mime: file.mime,
    sizeBytes: file.sizeBytes,
    chunks: ordered.map(({ objectKey, plainOffset, plainSize }) => ({ objectKey, plainOffset, plainSize })),
  };
};

/** `m:ss` (or `h:mm:ss`) for a position or duration in milliseconds; `--:--` when unknown. */
export const formatDuration = (ms: number | null | undefined): string =>
  ms == null || !Number.isFinite(ms) || ms < 0 ? "--:--" : formatClock(ms / 1000);
