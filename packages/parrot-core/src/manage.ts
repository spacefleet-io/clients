/**
 * Deleting and editing what is in the user's music library (PAR-LIB-03, PAR-LIB-04): pure planners that read the
 * library through a query function and return the ops to publish plus the stored objects to delete. Every app that
 * manages the library uses these, so a song, album or artist leaves (or changes) the same way everywhere.
 */
import type { MusicAlbum } from "@space/shared/api";
import { createParrotOp, parseParrotTracklist, type AlbumRow, type ArtistRow, type ParrotLibraryOp, type TrackRow } from "@space/parrot-library-db-definition";
import { parrotTrackByTitle } from "./importMatch";
import { ALBUM_TRACKLIST_SQL } from "./queries";

/**
 * Runs a read-only statement on the library file and returns its rows: synchronously (bun:sqlite, node:sqlite,
 * better-sqlite3 on the desktop) or as a promise (the phone's SQLite only runs async). The planners await either.
 */
export type ParrotLibraryQuery = <Row>(sql: string, params?: readonly (string | number | null)[]) => Row[] | Promise<Row[]>;

export type ParrotManageContext = {
  now: number;
  newId: () => string;
  /** The importer's ID scheme, so an artist or album typed by the user lands on the row an import would use. */
  ids: { artistId: (name: string) => string; albumId: (albumArtistId: string, title: string) => string };
};

export type ParrotManageKind = "track" | "album" | "artist";
export type ParrotManageTarget = { kind: ParrotManageKind; id: string };

export type ParrotDeletePlan = {
  ops: ParrotLibraryOp[];
  /** Audio chunks of every removed song, both cover copies of every removed album and both photo copies of every removed artist: deleted from storage first. */
  objectKeys: string[];
  trackCount: number;
  albumCount: number;
};

const ALBUM_COLUMNS = `id, title, album_artist_id AS albumArtistId, year, kind, music_id AS musicId,
  music_edition_id AS musicEditionId, cover_object_key AS coverObjectKey, cover_thumb_object_key AS coverThumbObjectKey,
  created_at AS createdAt, genre, year_edited = 1 AS yearEdited, genre_edited = 1 AS genreEdited, edited = 1 AS edited`;
const TRACK_COLUMNS = `id, album_id AS albumId, disc, number, title, artist_id AS artistId, duration_ms AS durationMs,
  music_id AS musicId, year, genre, year_edited = 1 AS yearEdited, genre_edited = 1 AS genreEdited`;

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

const first = async <Row>(rows: Row[] | Promise<Row[]>): Promise<Row | null> => (await rows)[0] ?? null;
const albumRow = (query: ParrotLibraryQuery, id: string) => first(query<AlbumRow>(`SELECT ${ALBUM_COLUMNS} FROM albums WHERE id = ?`, [id]));
const trackRow = (query: ParrotLibraryQuery, id: string) => first(query<TrackRow>(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id = ?`, [id]));
const artistRow = (query: ParrotLibraryQuery, id: string) => first(query<ArtistRow>("SELECT id, music_id AS musicId, name, sort_name AS sortName FROM artists WHERE id = ?", [id]));
const albumTracks = async (query: ParrotLibraryQuery, albumId: string) =>
  query<TrackRow>(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE album_id = ? ORDER BY disc, number`, [albumId]);

/**
 * Where a song titled `title` belongs on the album's stored tracklist, among the slots no other owned song fills; null
 * when the tracklist is unknown, the title is not on it, or the song already sits there (PAR-LIB-05).
 */
const tracklistSlot = async (query: ParrotLibraryQuery, albumId: string, trackId: string, title: string, current: { disc: number; number: number | null }) => {
  const listed = parseParrotTracklist((await first(query<{ tracklist: string | null }>(ALBUM_TRACKLIST_SQL, [albumId])))?.tracklist ?? null);
  if (!listed) return null;
  const taken = new Set((await albumTracks(query, albumId)).filter((t) => t.id !== trackId && t.number != null).map((t) => `${t.disc}:${t.number}`));
  const slot = parrotTrackByTitle(title, listed.filter((l) => !taken.has(`${l.disc}:${l.number}`)));
  if (!slot || (slot.disc === current.disc && slot.number === current.number)) return null;
  return { disc: slot.disc, number: slot.number };
};

const chunkKeys = async (query: ParrotLibraryQuery, trackIds: readonly string[]) =>
  trackIds.length === 0
    ? []
    : (
        await query<{ objectKey: string }>(
          `SELECT c.object_key AS objectKey FROM track_file_chunks c JOIN track_files f ON f.id = c.track_file_id
         WHERE f.track_id IN (${placeholders(trackIds.length)}) ORDER BY f.track_id, f.id, c.idx`,
          trackIds
        )
      ).map((r) => r.objectKey);

const coverKeys = (album: Pick<AlbumRow, "coverObjectKey" | "coverThumbObjectKey">) =>
  [album.coverObjectKey, album.coverThumbObjectKey].filter((k): k is string => !!k);

/** Both stored copies of the given artists' photos (PAR-META-15). */
const pictureKeys = async (query: ParrotLibraryQuery, artistIds: readonly string[]) =>
  artistIds.length === 0
    ? []
    : (
        await query<{ large: string | null; thumb: string | null }>(
          `SELECT picture_object_key AS large, picture_thumb_object_key AS thumb FROM artists WHERE id IN (${placeholders(artistIds.length)}) ORDER BY id`,
          artistIds
        )
      ).flatMap((row) => [row.large, row.thumb].filter((k): k is string => !!k));

/** Albums of `candidates` left with no song once `goneTracks` are removed. */
const emptiedAlbums = async (query: ParrotLibraryQuery, candidates: Iterable<string>, goneTracks: ReadonlySet<string>) => {
  const emptied: string[] = [];
  for (const albumId of new Set(candidates)) {
    if ((await albumTracks(query, albumId)).every((t) => goneTracks.has(t.id))) emptied.push(albumId);
  }
  return emptied;
};

/** Artists of `candidates` no remaining song or album points at once the given songs and albums are removed. */
const orphanedArtists = async (
  query: ParrotLibraryQuery,
  candidates: Iterable<string>,
  goneTracks: ReadonlySet<string>,
  goneAlbums: ReadonlySet<string>,
  changed: { tracks?: ReadonlyMap<string, string>; albums?: ReadonlyMap<string, string> } = {}
) => {
  const orphaned: string[] = [];
  for (const artistId of new Set(candidates)) {
    const tracks = await query<{ id: string }>("SELECT id FROM tracks WHERE artist_id = ?", [artistId]);
    const albums = await query<{ id: string }>("SELECT id FROM albums WHERE album_artist_id = ?", [artistId]);
    const trackUsed = tracks.some((t) => !goneTracks.has(t.id) && (changed.tracks?.get(t.id) ?? artistId) === artistId);
    const albumUsed = albums.some((a) => !goneAlbums.has(a.id) && (changed.albums?.get(a.id) ?? artistId) === artistId);
    const newlyUsed = [...(changed.tracks?.values() ?? []), ...(changed.albums?.values() ?? [])].includes(artistId);
    if (!trackUsed && !albumUsed && !newlyUsed) orphaned.push(artistId);
  }
  return orphaned;
};

/**
 * What deleting a song, an album or an artist removes. An album takes its songs; an artist takes the albums it is
 * the album artist of and its songs on other albums. Albums left empty and artists nothing points at any more go too.
 */
export const planParrotDelete = async (
  query: ParrotLibraryQuery,
  target: ParrotManageTarget,
  ctx: Pick<ParrotManageContext, "now" | "newId">
): Promise<ParrotDeletePlan> => {
  const meta = () => ({ id: ctx.newId(), createdAt: new Date(ctx.now).toISOString() });
  const explicitAlbums: string[] = [];
  let tracks: TrackRow[] = [];
  const artistCandidates: string[] = [];
  if (target.kind === "track") {
    const track = await trackRow(query, target.id);
    if (track) tracks = [track];
  } else if (target.kind === "album") {
    if (await albumRow(query, target.id)) explicitAlbums.push(target.id);
    tracks = await albumTracks(query, target.id);
  } else {
    if (await artistRow(query, target.id)) artistCandidates.push(target.id);
    explicitAlbums.push(...(await query<{ id: string }>("SELECT id FROM albums WHERE album_artist_id = ?", [target.id])).map((r) => r.id));
    const ids = explicitAlbums;
    tracks = await query<TrackRow>(
      `SELECT ${TRACK_COLUMNS} FROM tracks WHERE artist_id = ?${ids.length ? ` OR album_id IN (${placeholders(ids.length)})` : ""} ORDER BY album_id, disc, number`,
      [target.id, ...ids]
    );
  }
  const goneTracks = new Set(tracks.map((t) => t.id));
  const goneAlbumIds = [...new Set([...explicitAlbums, ...(await emptiedAlbums(query, tracks.map((t) => t.albumId), goneTracks))])];
  const goneAlbums: AlbumRow[] = [];
  for (const id of goneAlbumIds) {
    const album = await albumRow(query, id);
    if (album) goneAlbums.push(album);
  }
  const goneAlbumSet = new Set(goneAlbumIds);
  artistCandidates.push(...tracks.map((t) => t.artistId), ...goneAlbums.map((a) => a.albumArtistId));
  const goneArtists = await orphanedArtists(query, artistCandidates, goneTracks, goneAlbumSet);
  const ops: ParrotLibraryOp[] = [
    ...tracks.filter((t) => !goneAlbumSet.has(t.albumId)).map((t) => createParrotOp("track.delete", { id: t.id }, meta())),
    ...goneAlbums.map((a) => createParrotOp("album.delete", { id: a.id }, meta())),
    ...goneArtists.map((id) => createParrotOp("artist.delete", { id }, meta())),
  ];
  return {
    ops,
    objectKeys: [...(await chunkKeys(query, [...goneTracks])), ...goneAlbums.flatMap(coverKeys), ...(await pictureKeys(query, goneArtists))],
    trackCount: goneTracks.size,
    albumCount: goneAlbums.length,
  };
};

export type ParrotTrackEdit = {
  title: string;
  artist: string;
  album: string;
  number: number | null;
  disc: number;
  year: number | null;
  genre: string | null;
};

export type ParrotAlbumEdit = {
  title: string;
  albumArtist: string;
  year: number | null;
  genre: string | null;
  /** A new cover already uploaded; absent keeps the current one. */
  cover?: { coverObjectKey: string; coverThumbObjectKey: string | null };
};

export type ParrotEditTarget = { kind: "track"; id: string; edit: ParrotTrackEdit } | { kind: "album"; id: string; edit: ParrotAlbumEdit };

export type ParrotEditPlan = {
  ops: ParrotLibraryOp[];
  /** Stored objects nothing points at after the edit (a replaced cover, the cover of an album a move emptied). */
  objectKeys: string[];
};

const clean = (value: string) => value.replace(/\s+/g, " ").trim();
const cleanOrNull = (value: string | null) => (value === null ? null : clean(value) || null);

/** The values the edit dialog opens with. */
export const parrotTrackEditValues = async (query: ParrotLibraryQuery, trackId: string): Promise<ParrotTrackEdit | null> => {
  const track = await trackRow(query, trackId);
  if (!track) return null;
  const album = await albumRow(query, track.albumId);
  const artist = await artistRow(query, track.artistId);
  return {
    title: track.title,
    artist: artist?.name ?? "",
    album: album?.title ?? "",
    number: track.number,
    disc: track.disc,
    // A year or genre the user emptied on the song stays empty; otherwise the album's shows through (PAR-META-17).
    year: track.yearEdited ? (track.year ?? null) : (track.year ?? album?.year ?? null),
    genre: track.genreEdited ? (track.genre ?? null) : (track.genre ?? album?.genre ?? null),
  };
};

export const parrotAlbumEditValues = async (query: ParrotLibraryQuery, albumId: string): Promise<(ParrotAlbumEdit & { coverObjectKey: string | null }) | null> => {
  const album = await albumRow(query, albumId);
  if (!album) return null;
  const artist = await artistRow(query, album.albumArtistId);
  return {
    title: album.title,
    albumArtist: artist?.name ?? "",
    year: album.year,
    genre: album.genre ?? null,
    coverObjectKey: album.coverThumbObjectKey ?? album.coverObjectKey,
  };
};

/**
 * The ops that apply the user's edit (PAR-LIB-04). Row IDs never change: an edit rewrites the row. A typed artist or
 * album that does not exist yet is created under the importer's ID; an album or artist the edit leaves unused goes.
 */
export const planParrotEdit = async (query: ParrotLibraryQuery, target: ParrotEditTarget, ctx: ParrotManageContext): Promise<ParrotEditPlan> => {
  const meta = () => ({ id: ctx.newId(), createdAt: new Date(ctx.now).toISOString() });
  const ops: ParrotLibraryOp[] = [];
  const ensureArtist = async (rawName: string, fallbackId: string) => {
    const name = clean(rawName);
    if (!name) return fallbackId;
    const id = ctx.ids.artistId(name);
    const existing = await artistRow(query, id);
    if (!existing || existing.name !== name) {
      ops.push(createParrotOp("artist.upsert", { id, musicId: existing?.musicId ?? null, name, sortName: name }, meta()));
    }
    return id;
  };

  if (target.kind === "album") {
    const album = await albumRow(query, target.id);
    if (!album) return { ops: [], objectKeys: [] };
    const e = target.edit;
    const albumArtistId = await ensureArtist(e.albumArtist, album.albumArtistId);
    const genre = cleanOrNull(e.genre);
    // PAR-META-17: a year or genre the user changed, emptied included, is his from now on; one he left as it was keeps
    // the flag it had, so an untouched field still follows later imports.
    const yearEdited = e.year !== album.year || !!album.yearEdited;
    const genreEdited = genre !== (album.genre ?? null) || !!album.genreEdited;
    const title = clean(e.title) || album.title;
    // PAR-COPY-01: a title, artist or cover the user changed is his; a new music copy no longer refreshes the album.
    const edited = title !== album.title || albumArtistId !== album.albumArtistId || !!e.cover || !!album.edited;
    ops.push(
      createParrotOp(
        "album.upsert",
        {
          ...album,
          title,
          albumArtistId,
          year: e.year,
          genre,
          yearEdited,
          genreEdited,
          edited,
          coverObjectKey: e.cover?.coverObjectKey ?? null,
          coverThumbObjectKey: e.cover ? e.cover.coverThumbObjectKey : null,
        },
        meta()
      )
    );
    // The album's year and genre are its songs' too.
    for (const track of await albumTracks(query, album.id)) {
      ops.push(
        createParrotOp(
          "track.upsert",
          { ...track, year: e.year, genre, yearEdited: yearEdited || !!track.yearEdited, genreEdited: genreEdited || !!track.genreEdited },
          meta()
        )
      );
    }
    const replacedCover = e.cover ? coverKeys(album).filter((k) => k !== e.cover?.coverObjectKey && k !== e.cover?.coverThumbObjectKey) : [];
    const goneArtists =
      albumArtistId === album.albumArtistId
        ? []
        : await orphanedArtists(query, [album.albumArtistId], new Set(), new Set(), { albums: new Map([[album.id, albumArtistId]]) });
    ops.push(...goneArtists.map((id) => createParrotOp("artist.delete", { id }, meta())));
    return { ops, objectKeys: [...replacedCover, ...(await pictureKeys(query, goneArtists))] };
  }

  const track = await trackRow(query, target.id);
  if (!track) return { ops: [], objectKeys: [] };
  const e = target.edit;
  const oldAlbum = await albumRow(query, track.albumId);
  const artistId = await ensureArtist(e.artist, track.artistId);
  let albumId = track.albumId;
  const albumTitle = clean(e.album);
  if (oldAlbum && albumTitle && albumTitle.toLowerCase() !== oldAlbum.title.toLowerCase()) {
    // A song moved to another album keeps its album artist; the album is found or created like an import would.
    albumId = ctx.ids.albumId(oldAlbum.albumArtistId, albumTitle);
    if (!(await albumRow(query, albumId))) {
      ops.push(
        createParrotOp(
          "album.upsert",
          {
            id: albumId,
            title: albumTitle,
            albumArtistId: oldAlbum.albumArtistId,
            year: e.year,
            kind: oldAlbum.kind,
            musicId: null,
            musicEditionId: null,
            coverObjectKey: null,
            coverThumbObjectKey: null,
            createdAt: ctx.now,
            genre: cleanOrNull(e.genre),
          },
          meta()
        )
      );
    }
  } else if (oldAlbum && albumTitle && albumTitle !== oldAlbum.title) {
    // Only the case changed: the album keeps its row and takes the new spelling.
    ops.push(
      createParrotOp(
        "album.upsert",
        {
          ...oldAlbum,
          title: albumTitle,
          coverObjectKey: null,
          coverThumbObjectKey: null,
          yearEdited: !!oldAlbum.yearEdited,
          genreEdited: !!oldAlbum.genreEdited,
          // The user respelled the album's title: his from now on (PAR-COPY-01).
          edited: true,
        },
        meta()
      )
    );
  }
  // PAR-META-17: what the dialog opened with; a year or genre changed from it, emptied included, is the user's.
  const opened = await parrotTrackEditValues(query, track.id);
  const genre = cleanOrNull(e.genre);
  const title = clean(e.title) || track.title;
  // PAR-LIB-05 (issue #2507): a song whose number the user left as it was takes its own title's track on the album's
  // tracklist, so a song moved from another edition fills its slot instead of sitting beside a "Not in your library" copy.
  const typedPlace = e.number !== (opened?.number ?? null) || e.disc !== (opened?.disc ?? 1);
  const place = typedPlace ? null : await tracklistSlot(query, albumId, track.id, title, { disc: e.disc > 0 ? e.disc : 1, number: e.number });
  ops.push(
    createParrotOp(
      "track.upsert",
      {
        ...track,
        title,
        artistId,
        albumId,
        number: place?.number ?? e.number,
        disc: place?.disc ?? (e.disc > 0 ? e.disc : 1),
        year: e.year,
        genre,
        yearEdited: e.year !== (opened?.year ?? null) || !!track.yearEdited,
        genreEdited: genre !== (opened?.genre ?? null) || !!track.genreEdited,
      },
      meta()
    )
  );
  const objectKeys: string[] = [];
  const goneAlbums = albumId !== track.albumId && oldAlbum ? await emptiedAlbums(query, [oldAlbum.id], new Set([track.id])) : [];
  for (const id of goneAlbums) {
    ops.push(createParrotOp("album.delete", { id }, meta()));
    if (oldAlbum) objectKeys.push(...coverKeys(oldAlbum));
  }
  const candidates = [...(artistId !== track.artistId ? [track.artistId] : []), ...(goneAlbums.length && oldAlbum ? [oldAlbum.albumArtistId] : [])];
  const goneArtists = await orphanedArtists(query, candidates, new Set(), new Set(goneAlbums), { tracks: new Map([[track.id, artistId]]) });
  ops.push(...goneArtists.map((id) => createParrotOp("artist.delete", { id }, meta())));
  return { ops, objectKeys: [...objectKeys, ...(await pictureKeys(query, goneArtists))] };
};


/**
 * Even volume (PAR-PLAY-03): the op that stores a song's measured loudness, the rest of its row unchanged. Null when
 * the song is gone or already has a value (its file's ReplayGain tag or an earlier measurement wins).
 */
export const planParrotTrackLoudness = async (
  query: ParrotLibraryQuery,
  trackId: string,
  measured: { gainDb: number; peak: number },
  ctx: Pick<ParrotManageContext, "now" | "newId">
): Promise<ParrotLibraryOp | null> => {
  const track = await first(query<TrackRow & { measured: number }>(`SELECT ${TRACK_COLUMNS}, gain_db IS NOT NULL AS measured FROM tracks WHERE id = ?`, [trackId]));
  if (!track || track.measured) return null;
  const { measured: _known, ...row } = track;
  return createParrotOp("track.upsert", { ...row, gainDb: measured.gainDb, peak: measured.peak }, { id: ctx.newId(), createdAt: new Date(ctx.now).toISOString() });
};

/** A song kept as is at import, now matched with confidence to one track (disc, number) of `album` (PAR-UP-05). */
export type ParrotTrackPlacement = { trackId: string; album: MusicAlbum; disc: number; number: number };

/**
 * The ops that move songs kept as is onto the tracks they were matched to (PAR-UP-05, issue #2531): each joins the
 * library's album of that id in the metadata, else the album an import of it would make (created with the full
 * tracklist), takes the track's title and place and loses its unidentified mark. A song no longer unidentified (the
 * user edited it, another device placed it) or whose track another song already fills stays as it is. Albums the
 * moves leave empty go, with their covers; so do artists nothing points at any more.
 */
export const planParrotTrackPlacements = async (
  query: ParrotLibraryQuery,
  placements: readonly ParrotTrackPlacement[],
  ctx: ParrotManageContext
): Promise<ParrotEditPlan> => {
  const meta = () => ({ id: ctx.newId(), createdAt: new Date(ctx.now).toISOString() });
  const ops: ParrotLibraryOp[] = [];
  /** The albums songs land on, by their album artist: none of them is left empty. */
  const targets = new Map<string, string>();
  const newArtists = new Set<string>();
  const moved = new Map<string, string>();
  const taken = new Set<string>();
  for (const placement of placements) {
    const track = await first(query<TrackRow & { unidentified: number | null }>(`SELECT ${TRACK_COLUMNS}, unidentified FROM tracks WHERE id = ?`, [placement.trackId]));
    const slot = placement.album.tracks.find((t) => t.disc === placement.disc && t.number === placement.number);
    if (!track || track.unidentified !== 1 || !slot) continue;
    const albumArtist = clean(placement.album.artist.name);
    const albumArtistId = ctx.ids.artistId(albumArtist);
    const group = placement.album.id;
    const known = group ? await first(query<AlbumRow>(`SELECT ${ALBUM_COLUMNS} FROM albums WHERE music_id = ? ORDER BY id`, [group])) : null;
    const albumId = known?.id ?? ctx.ids.albumId(albumArtistId, clean(placement.album.title));
    const album = known ?? (await albumRow(query, albumId));
    const place = `${albumId}\u0000${slot.disc}:${slot.number}`;
    const filled = (await albumTracks(query, albumId)).some((t) => t.id !== track.id && !moved.has(t.id) && t.disc === slot.disc && t.number === slot.number);
    if (filled || taken.has(place)) continue;
    taken.add(place);
    const tracklist = placement.album.tracks.map((t) => ({ disc: t.disc, number: t.number, title: t.title, durationMs: t.durationMs }));
    if (!album && !targets.has(albumId)) {
      if (!(await artistRow(query, albumArtistId)) && !newArtists.has(albumArtistId)) {
        ops.push(createParrotOp("artist.upsert", { id: albumArtistId, musicId: placement.album.artist.id, name: albumArtist, sortName: albumArtist }, meta()));
        newArtists.add(albumArtistId);
      }
      ops.push(
        createParrotOp(
          "album.upsert",
          {
            id: albumId,
            title: clean(placement.album.title),
            albumArtistId,
            year: placement.album.year,
            kind: "studio",
            musicId: group,
            musicEditionId: null,
            coverObjectKey: null,
            coverThumbObjectKey: null,
            createdAt: ctx.now,
            genre: null,
            tracklist,
          },
          meta()
        )
      );
    } else if (album && !targets.has(albumId) && !parseParrotTracklist((await first(query<{ tracklist: string | null }>(ALBUM_TRACKLIST_SQL, [albumId])))?.tracklist ?? null)) {
      // The album an earlier import stored without its tracklist gets this one, like an import of its files would.
      ops.push(createParrotOp("album.upsert", { ...album, yearEdited: !!album.yearEdited, genreEdited: !!album.genreEdited, tracklist }, meta()));
    }
    targets.set(albumId, album?.albumArtistId ?? albumArtistId);
    if (albumId !== track.albumId) moved.set(track.id, track.albumId);
    ops.push(
      createParrotOp(
        "track.upsert",
        {
          ...track,
          albumId,
          disc: slot.disc,
          number: slot.number,
          title: slot.title,
          musicId: slot.id ?? track.musicId,
          yearEdited: !!track.yearEdited,
          genreEdited: !!track.genreEdited,
          unidentified: false,
        },
        meta()
      )
    );
  }
  const objectKeys: string[] = [];
  const left = [...new Set(moved.values())].filter((id) => !targets.has(id));
  const goneAlbums = await emptiedAlbums(query, left, new Set(moved.keys()));
  const goneArtists: string[] = [];
  for (const id of goneAlbums) {
    const album = await albumRow(query, id);
    ops.push(createParrotOp("album.delete", { id }, meta()));
    if (!album) continue;
    objectKeys.push(...coverKeys(album));
    goneArtists.push(album.albumArtistId);
  }
  const orphaned = await orphanedArtists(query, goneArtists, new Set(), new Set(goneAlbums), { albums: targets });
  ops.push(...orphaned.map((id) => createParrotOp("artist.delete", { id }, meta())));
  return { ops, objectKeys: [...objectKeys, ...(await pictureKeys(query, orphaned))] };
};
