/**
 * Settings › "Manage offline content" (OFFL-MANAGE-01): what is kept on the device to play offline, each item with the
 * space it takes and the total at the top. Pure grouping shared by every app that shows the list (Badger and Parrot on
 * the phones and the computers): no app, platform or React import here.
 *
 * - Badger: saved files group into films, and shows › seasons › episodes.
 * - Parrot phone: artists › albums › songs (a song kept on its own sits under its artist and album too), then playlists
 *   › songs (`groupParrotOfflineTree`). Parrot desktop: kept albums, playlists and songs kept on their own
 *   (`groupParrotOffline`).
 *
 * A file counts once in the total even when two items hold it (a song in a kept album and a kept playlist).
 */

export type OfflineManageKind = "movie" | "show" | "season" | "episode" | "artist" | "album" | "playlist" | "song";

export type OfflineManageRow = {
  /** Unique among the list's rows (React key, test id). */
  key: string;
  kind: OfflineManageKind;
  /**
   * Library id of the film, show, artist, album, playlist or song; a season or episode row carries its show's id; an
   * artist row with no artist in the library is "".
   */
  id: string;
  /** Null when the library no longer names it (the screen shows a fallback). */
  title: string | null;
  /** Second line: the artist of an album or song. */
  subtitle: string | null;
  /** The app's own picture reference (Badger poster path, Parrot cover key); null = none. */
  imagePath: string | null;
  bytes: number;
  /** Badger season and episode rows. */
  seasonNumber?: number;
  episodeNumber?: number;
  /** Badger film and episode rows, Parrot phone song rows: the saved file. */
  fileId?: string;
  /** Parrot phone: a playlist row and the song rows under it (removing them leaves the songs out of that playlist only). */
  playlistId?: string;
  /** A show's seasons (then episodes the library no longer places), a season's episodes; an artist's albums, an album's or a playlist's songs. */
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

/** One kept song on the Parrot phone with the file kept for it and what the library says about it. */
export type ParrotOfflineSong = {
  trackId: string;
  fileId: string;
  title: string | null;
  albumId: string | null;
  /** The song's own artist: used when the album is not in the library. */
  artistId: string | null;
  artistName: string | null;
  disc?: number;
  number?: number | null;
};

export type ParrotOfflineAlbum = { title: string; artistId: string | null; artistName: string | null; imagePath: string | null };

/**
 * The Parrot phone's three-level list (OFFL-MANAGE-01): artists A–Z › albums › songs from kept albums and songs kept on
 * their own (a song in both is listed once), then kept playlists A–Z › their songs. An album's artist places it (the
 * song's own artist when the library no longer has the album); a song whose album is gone sits right under its artist.
 * Row keys: `artist:<id>`, `album:<id>`, `song:<trackId>`, `playlist:<id>`, `playlist:<id>/song:<trackId>`. Each row's
 * size and the total count every file once.
 */
export const groupParrotOfflineTree = (input: {
  /** Songs of kept albums and songs kept on their own. */
  songs: readonly ParrotOfflineSong[];
  playlists: ReadonlyArray<{ id: string; title: string | null; imagePath?: string | null; songs: readonly ParrotOfflineSong[] }>;
  albumOf: (albumId: string) => ParrotOfflineAlbum | null;
  /** An artist's own picture; its first album's cover otherwise. */
  artistImageOf?: (artistId: string) => string | null;
  bytesOf: (fileId: string) => number;
}): OfflineManageList => {
  const { albumOf, bytesOf } = input;
  const sizeOf = (fileIds: Iterable<string>) => [...new Set(fileIds)].reduce((sum, fileId) => sum + bytesOf(fileId), 0);
  const filesUnder = (row: OfflineManageRow): string[] => (row.fileId ? [row.fileId] : row.children.flatMap(filesUnder));
  const bySong = (a: { song: ParrotOfflineSong; row: OfflineManageRow }, b: { song: ParrotOfflineSong; row: OfflineManageRow }) =>
    (a.song.disc ?? 1) - (b.song.disc ?? 1) || (a.song.number ?? Number.MAX_SAFE_INTEGER) - (b.song.number ?? Number.MAX_SAFE_INTEGER) || byTitle(a.row, b.row);
  const songRow = (song: ParrotOfflineSong, playlistId?: string): OfflineManageRow => ({
    key: playlistId ? `playlist:${playlistId}/song:${song.trackId}` : `song:${song.trackId}`,
    kind: "song",
    id: song.trackId,
    title: song.title,
    subtitle: playlistId ? song.artistName : null,
    imagePath: null,
    bytes: bytesOf(song.fileId),
    fileId: song.fileId,
    ...(playlistId ? { playlistId } : {}),
    children: [],
  });

  type Artist = { row: OfflineManageRow; albums: Map<string, { row: OfflineManageRow; songs: Array<{ song: ParrotOfflineSong; row: OfflineManageRow }> }>; loose: Array<{ song: ParrotOfflineSong; row: OfflineManageRow }> };
  const artists = new Map<string, Artist>();
  const seen = new Set<string>();
  for (const song of input.songs) {
    if (seen.has(song.trackId)) continue;
    seen.add(song.trackId);
    const album = song.albumId ? albumOf(song.albumId) : null;
    const artistId = (album ? album.artistId : song.artistId) || "";
    const artistName = (album ? album.artistName : song.artistName) || null;
    const artistKey = artistId || `name:${artistName ?? ""}`;
    let artist = artists.get(artistKey);
    if (!artist) {
      artist = {
        row: { key: `artist:${artistKey}`, kind: "artist", id: artistId, title: artistName, subtitle: null, imagePath: (artistId && input.artistImageOf?.(artistId)) || null, bytes: 0, children: [] },
        albums: new Map(),
        loose: [],
      };
      artists.set(artistKey, artist);
    }
    const entry = { song, row: songRow(song) };
    if (!album || !song.albumId) {
      artist.loose.push(entry);
      continue;
    }
    let albumSlot = artist.albums.get(song.albumId);
    if (!albumSlot) {
      albumSlot = {
        row: { key: `album:${song.albumId}`, kind: "album", id: song.albumId, title: album.title, subtitle: null, imagePath: album.imagePath, bytes: 0, children: [] },
        songs: [],
      };
      artist.albums.set(song.albumId, albumSlot);
    }
    albumSlot.songs.push(entry);
  }

  const artistRows = [...artists.values()].map(({ row, albums, loose }) => {
    const albumRows = [...albums.values()].map((slot) => ({ ...slot.row, children: slot.songs.sort(bySong).map((entry) => entry.row) })).sort(byTitle);
    for (const album of albumRows) album.bytes = sizeOf(filesUnder(album));
    const artistRow: OfflineManageRow = { ...row, imagePath: row.imagePath ?? albumRows.find((album) => album.imagePath)?.imagePath ?? null, children: [...albumRows, ...loose.sort(bySong).map((entry) => entry.row)] };
    artistRow.bytes = sizeOf(filesUnder(artistRow));
    return artistRow;
  });
  artistRows.sort(byTitle);

  const playlistRows = input.playlists.map((playlist): OfflineManageRow => {
    const children = [...new Map(playlist.songs.map((song) => [song.trackId, song])).values()].map((song) => songRow(song, playlist.id));
    return {
      key: `playlist:${playlist.id}`,
      kind: "playlist",
      id: playlist.id,
      title: playlist.title,
      subtitle: null,
      imagePath: playlist.imagePath ?? null,
      bytes: sizeOf(children.flatMap(filesUnder)),
      playlistId: playlist.id,
      children,
    };
  });
  playlistRows.sort(byTitle);

  const rows = [...artistRows, ...playlistRows];
  return { rows, totalBytes: sizeOf(rows.flatMap(filesUnder)) };
};

/** The songs a Parrot phone row stands for (itself, or every song under it), for removing them. */
export const parrotOfflineTrackIds = (row: OfflineManageRow): string[] =>
  row.kind === "song" ? [row.id] : [...new Set(row.children.flatMap(parrotOfflineTrackIds))];
