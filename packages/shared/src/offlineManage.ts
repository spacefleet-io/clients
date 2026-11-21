/**
 * Settings › "Manage offline content" (OFFL-MANAGE-01): what is kept on the device to play offline, each item with the
 * space it takes and the total at the top. Pure grouping shared by every app that shows the list (Badger and Parrot
 * desktop now, the phones later): no app, platform or React import here.
 *
 * - Badger: saved files group into films, and shows › seasons › episodes.
 * - Parrot: kept albums, playlists and songs kept on their own.
 *
 * A file counts once in the total even when two items hold it (a song in a kept album and a kept playlist).
 */

export type OfflineManageKind = "movie" | "show" | "season" | "episode" | "album" | "playlist" | "song";

export type OfflineManageRow = {
  /** Unique among the list's rows (React key, test id). */
  key: string;
  kind: OfflineManageKind;
  /** Library id of the film, show, album, playlist or song; a season or episode row carries its show's id. */
  id: string;
  /** Null when the library no longer names it (the screen shows a fallback). */
  title: string | null;
  /** Second line: the artist of an album or song. */
  subtitle: string | null;
  /** The app's own picture reference (Badger poster path, Parrot cover URL); null = none. */
  imagePath: string | null;
  bytes: number;
  /** Badger season and episode rows. */
  seasonNumber?: number;
  episodeNumber?: number;
  /** Badger film and episode rows: the saved file. */
  fileId?: string;
  /** A show's seasons (then episodes the library no longer places); a season's episodes. */
  children: OfflineManageRow[];
};

export type OfflineManageList = { rows: OfflineManageRow[]; totalBytes: number };

const byTitle = (a: OfflineManageRow, b: OfflineManageRow) => {
  if (a.title === null || b.title === null) return a.title === b.title ? 0 : a.title === null ? 1 : -1;
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });
};

// ---------------------------------------------------------------------------
// Badger
// ---------------------------------------------------------------------------

/** One saved file, as `badger.offline.list_local` returns it. */
export type BadgerOfflineSaved = { mediaId: string; fileId: string; totalBytes: number };

/** What the list needs of a library title (a `MediaDetails` fits). */
export type BadgerOfflineTitle = {
  type: "movie" | "tv";
  title: string;
  posterPath: string | null;
  files: ReadonlyArray<{ id: string; season: number | null; episode: number | null }>;
  seasons?: ReadonlyArray<{ seasonNumber: number; name: string; posterPath: string | null }>;
  episodes?: ReadonlyArray<{ seasonNumber: number; episodeNumber: number; name: string }>;
};

export const groupBadgerOffline = (
  saved: readonly BadgerOfflineSaved[],
  titleOf: (mediaId: string) => BadgerOfflineTitle | null
): OfflineManageList => {
  const files = new Map<string, BadgerOfflineSaved>();
  for (const entry of saved) files.set(entry.fileId, entry);
  const byMedia = new Map<string, BadgerOfflineSaved[]>();
  for (const entry of files.values()) {
    const list = byMedia.get(entry.mediaId);
    if (list) list.push(entry);
    else byMedia.set(entry.mediaId, [entry]);
  }

  const rows: OfflineManageRow[] = [];
  for (const [mediaId, entries] of byMedia) {
    const title = titleOf(mediaId);
    const bytes = entries.reduce((sum, entry) => sum + entry.totalBytes, 0);
    if (!title || title.type === "movie") {
      rows.push({
        key: `movie:${mediaId}`,
        kind: "movie",
        id: mediaId,
        title: title?.title ?? null,
        subtitle: null,
        imagePath: title?.posterPath ?? null,
        bytes,
        fileId: entries.length === 1 ? entries[0].fileId : undefined,
        children: [],
      });
      continue;
    }

    const seasons = new Map<number, OfflineManageRow>();
    const loose: OfflineManageRow[] = [];
    for (const entry of entries) {
      const file = title.files.find((candidate) => candidate.id === entry.fileId);
      const episodeNumber = file?.episode ?? null;
      const seasonNumber = file?.season ?? null;
      const episode =
        seasonNumber !== null && episodeNumber !== null
          ? title.episodes?.find((candidate) => candidate.seasonNumber === seasonNumber && candidate.episodeNumber === episodeNumber)
          : undefined;
      const row: OfflineManageRow = {
        key: `episode:${entry.fileId}`,
        kind: "episode",
        id: mediaId,
        title: episode?.name ?? null,
        subtitle: null,
        imagePath: null,
        bytes: entry.totalBytes,
        fileId: entry.fileId,
        ...(seasonNumber !== null ? { seasonNumber } : {}),
        ...(episodeNumber !== null ? { episodeNumber } : {}),
        children: [],
      };
      if (seasonNumber === null) {
        loose.push(row);
        continue;
      }
      let season = seasons.get(seasonNumber);
      if (!season) {
        const info = title.seasons?.find((candidate) => candidate.seasonNumber === seasonNumber);
        season = {
          key: `season:${mediaId}:${seasonNumber}`,
          kind: "season",
          id: mediaId,
          title: info?.name ?? null,
          subtitle: null,
          imagePath: info?.posterPath ?? title.posterPath,
          bytes: 0,
          seasonNumber,
          children: [],
        };
        seasons.set(seasonNumber, season);
      }
      season.bytes += row.bytes;
      season.children.push(row);
    }
    const seasonRows = [...seasons.values()].sort((a, b) => (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0));
    for (const season of seasonRows) season.children.sort((a, b) => (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
    rows.push({
      key: `show:${mediaId}`,
      kind: "show",
      id: mediaId,
      title: title.title,
      subtitle: null,
      imagePath: title.posterPath,
      bytes,
      children: [...seasonRows, ...loose],
    });
  }
  rows.sort(byTitle);
  return { rows, totalBytes: [...files.values()].reduce((sum, entry) => sum + entry.totalBytes, 0) };
};

// ---------------------------------------------------------------------------
// Parrot
// ---------------------------------------------------------------------------

export type ParrotOfflineKind = "album" | "playlist" | "song";

/** One kept item with the song files it holds on the device. */
export type ParrotOfflineKept = { kind: ParrotOfflineKind; id: string; fileIds: readonly string[] };

const PARROT_ORDER: Record<ParrotOfflineKind, number> = { album: 0, playlist: 1, song: 2 };

export const groupParrotOffline = (
  kept: readonly ParrotOfflineKept[],
  bytesOf: (fileId: string) => number,
  describe: (kind: ParrotOfflineKind, id: string) => { title: string; subtitle?: string | null; imagePath?: string | null } | null
): OfflineManageList => {
  const all = new Set<string>();
  const rows = kept.map((item): OfflineManageRow => {
    const fileIds = new Set(item.fileIds);
    for (const fileId of fileIds) all.add(fileId);
    const named = describe(item.kind, item.id);
    return {
      key: `${item.kind}:${item.id}`,
      kind: item.kind,
      id: item.id,
      title: named?.title ?? null,
      subtitle: named?.subtitle ?? null,
      imagePath: named?.imagePath ?? null,
      bytes: [...fileIds].reduce((sum, fileId) => sum + bytesOf(fileId), 0),
      children: [],
    };
  });
  rows.sort((a, b) => PARROT_ORDER[a.kind as ParrotOfflineKind] - PARROT_ORDER[b.kind as ParrotOfflineKind] || byTitle(a, b));
  return { rows, totalBytes: [...all].reduce((sum, fileId) => sum + bytesOf(fileId), 0) };
};
