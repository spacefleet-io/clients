// Playlists and Liked songs (PAR-PL-01..05), the logic every Parrot surface shares: reading them out of the decrypted
// library (plain SQL, like ./queries) and turning the user's edits into library ops. An edit names what the user
// meant ("add these songs", "like this song"), not the rows it produced, so a save that lost a race against another
// device rebuilds its ops on the newer library and keeps both devices' changes (PAR-PL-03).
import { buildParrotOpStatements, createParrotOp, type ParrotLibraryOp } from "@space/parrot-library-db-definition/ops";

/** The fixed playlist behind the heart (PAR-PL-04): made on the first like, always first, never renamed or deleted. */
export const PARROT_LIKED_PLAYLIST_ID = "liked-songs";
/** Its stored name; every screen shows it in the app's language instead (`playlists.liked`). */
export const PARROT_LIKED_PLAYLIST_NAME = "Liked songs";
/** Longest playlist name kept; a longer one is cut. */
export const PARROT_PLAYLIST_NAME_MAX = 100;

/** The playlists (parameterless), any order: `buildParrotPlaylists` sorts them. */
export const PLAYLISTS_SQL = `SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM playlists`;
/** Every playlist's songs, each playlist's in its order. */
export const PLAYLIST_TRACKS_SQL = `SELECT playlist_id AS playlistId, track_id AS trackId FROM playlist_tracks ORDER BY playlist_id, position`;

export type ParrotPlaylistRow = { id: string; name: string; createdAt: number; updatedAt: number };
export type ParrotPlaylistTrackRow = { playlistId: string; trackId: string };

/** A playlist with its songs in order; a song may be in it more than once. */
export type ParrotPlaylist = ParrotPlaylistRow & { trackIds: string[]; trackCount: number };

export const isLikedPlaylist = (id: string) => id === PARROT_LIKED_PLAYLIST_ID;

/** Liked songs first, then the others by name, then oldest first. */
export const buildParrotPlaylists = (rows: readonly ParrotPlaylistRow[], trackRows: readonly ParrotPlaylistTrackRow[]): ParrotPlaylist[] => {
  const songs = new Map<string, string[]>();
  for (const row of trackRows) {
    const list = songs.get(row.playlistId);
    if (list) list.push(row.trackId);
    else songs.set(row.playlistId, [row.trackId]);
  }
  return rows
    .map((row) => {
      const trackIds = songs.get(row.id) ?? [];
      return { id: row.id, name: row.name, createdAt: row.createdAt, updatedAt: row.updatedAt, trackIds, trackCount: trackIds.length };
    })
    .sort(
      (a, b) =>
        Number(isLikedPlaylist(b.id)) - Number(isLikedPlaylist(a.id)) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) ||
        a.createdAt - b.createdAt
    );
};

/** The library's playlists, sorted, read through any SQLite client's `all` (node:sqlite, sql.js, the phone's). */
export const readParrotPlaylists = (all: <T>(sql: string) => T[]): ParrotPlaylist[] =>
  buildParrotPlaylists(all<ParrotPlaylistRow>(PLAYLISTS_SQL), all<ParrotPlaylistTrackRow>(PLAYLIST_TRACKS_SQL));

/** Every SQL statement `ops` run, in order; each client runs them on its own SQLite in one transaction. */
export const parrotOpStatements = (ops: readonly ParrotLibraryOp[]) =>
  ops.flatMap((op) => Object.values(buildParrotOpStatements(op)).flatMap((statements) => statements ?? []));

/** A name as stored: spaces trimmed and collapsed, at most PARROT_PLAYLIST_NAME_MAX characters; "" when nothing is left. */
export const cleanPlaylistName = (name: string) => name.replace(/\s+/g, " ").trim().slice(0, PARROT_PLAYLIST_NAME_MAX).trim();

export const isLikedSong = (playlists: readonly Pick<ParrotPlaylist, "id" | "trackIds">[], trackId: string) =>
  playlists.find((playlist) => isLikedPlaylist(playlist.id))?.trackIds.includes(trackId) ?? false;

/** A playlist's songs in its order, each with its place in the playlist; a song no longer in the library is left out. */
export const playlistEntries = <Song extends { id: string }>(
  playlist: Pick<ParrotPlaylist, "trackIds">,
  songs: readonly Song[]
): { song: Song; position: number }[] => {
  const byId = new Map(songs.map((song) => [song.id, song]));
  return playlist.trackIds.flatMap((trackId, position) => {
    const song = byId.get(trackId);
    return song ? [{ song, position }] : [];
  });
};

/** What the user did to their playlists. Positions and names are what the user saw when they did it. */
export type ParrotPlaylistEdit =
  | { kind: "create"; id: string; name: string; trackIds?: string[] }
  | { kind: "rename"; id: string; name: string }
  | { kind: "delete"; id: string }
  | { kind: "add"; id: string; trackIds: string[] }
  /** Takes out the song at `position`; when other changes moved it, the first `trackId` left in the playlist. */
  | { kind: "remove"; id: string; position: number; trackId: string }
  /** `liked` is the state the heart was set to, so replaying it twice changes nothing more. */
  | { kind: "like"; trackId: string; liked: boolean };

/** A new playlist with a fresh id, so songs can be added to it in the same save. */
export const newPlaylistEdit = (name: string, newId: () => string, trackIds: string[] = []): ParrotPlaylistEdit & { kind: "create" } => ({
  kind: "create",
  id: `pl-${newId()}`,
  name,
  trackIds,
});

/** The heart's edit: likes the song when it is not liked yet, unlikes it when it is. */
export const toggleLikeEdit = (playlists: readonly Pick<ParrotPlaylist, "id" | "trackIds">[], trackId: string): ParrotPlaylistEdit => ({
  kind: "like",
  trackId,
  liked: !isLikedSong(playlists, trackId),
});

type Playlists = readonly Pick<ParrotPlaylist, "id" | "trackIds">[];

/**
 * Whether every one of these songs is in Liked songs (an album's heart is filled then); false for none. `liked` lets
 * an app count likes it has not saved yet (the phone's editor); by default it reads `playlists`.
 */
export const areAllLiked = (
  playlists: Playlists,
  trackIds: readonly string[],
  liked: (trackId: string) => boolean = (trackId) => isLikedSong(playlists, trackId)
) => trackIds.length > 0 && trackIds.every(liked);

/** An album's heart: likes the songs not liked yet, or unlikes them all when every one is liked already. */
export const toggleLikeAllEdits = (
  playlists: Playlists,
  trackIds: readonly string[],
  liked: (trackId: string) => boolean = (trackId) => isLikedSong(playlists, trackId)
): Extract<ParrotPlaylistEdit, { kind: "like" }>[] => {
  const next = !areAllLiked(playlists, trackIds, liked);
  return trackIds.filter((trackId) => liked(trackId) !== next).map((trackId) => ({ kind: "like", trackId, liked: next }));
};

export type ParrotPlaylistEditContext = { now: number; newId: () => string };

type Draft = { row: ParrotPlaylistRow; trackIds: string[]; rowChanged: boolean; tracksChanged: boolean };

/**
 * The ops that make `edits` true on a library whose playlists are `playlists`. An edit whose playlist no longer
 * exists (another device deleted it) is dropped, as is a rename or delete of Liked songs and an empty name.
 */
export const parrotPlaylistEditOps = (
  playlists: readonly ParrotPlaylist[],
  edits: readonly ParrotPlaylistEdit[],
  context: ParrotPlaylistEditContext
): ParrotLibraryOp[] => {
  const drafts = new Map<string, Draft>(
    playlists.map((playlist) => [
      playlist.id,
      {
        row: { id: playlist.id, name: playlist.name, createdAt: playlist.createdAt, updatedAt: playlist.updatedAt },
        trackIds: [...playlist.trackIds],
        rowChanged: false,
        tracksChanged: false,
      },
    ])
  );
  const deleted = new Set<string>();
  const { now } = context;
  const touch = (draft: Draft, tracks: boolean) => {
    draft.rowChanged = true;
    draft.row = { ...draft.row, updatedAt: now };
    if (tracks) draft.tracksChanged = true;
  };
  const liked = () => {
    let draft = drafts.get(PARROT_LIKED_PLAYLIST_ID);
    if (!draft) {
      draft = { row: { id: PARROT_LIKED_PLAYLIST_ID, name: PARROT_LIKED_PLAYLIST_NAME, createdAt: now, updatedAt: now }, trackIds: [], rowChanged: true, tracksChanged: false };
      drafts.set(PARROT_LIKED_PLAYLIST_ID, draft);
      deleted.delete(PARROT_LIKED_PLAYLIST_ID);
    }
    return draft;
  };

  for (const edit of edits) {
    switch (edit.kind) {
      case "create": {
        const name = cleanPlaylistName(edit.name);
        if (!name || isLikedPlaylist(edit.id) || drafts.has(edit.id)) break;
        const trackIds = [...(edit.trackIds ?? [])];
        drafts.set(edit.id, { row: { id: edit.id, name, createdAt: now, updatedAt: now }, trackIds, rowChanged: true, tracksChanged: trackIds.length > 0 });
        deleted.delete(edit.id);
        break;
      }
      case "rename": {
        const draft = drafts.get(edit.id);
        const name = cleanPlaylistName(edit.name);
        if (!draft || !name || isLikedPlaylist(edit.id) || name === draft.row.name) break;
        draft.row = { ...draft.row, name };
        touch(draft, false);
        break;
      }
      case "delete": {
        if (isLikedPlaylist(edit.id) || !drafts.has(edit.id)) break;
        drafts.delete(edit.id);
        deleted.add(edit.id);
        break;
      }
      case "add": {
        const draft = isLikedPlaylist(edit.id) ? liked() : drafts.get(edit.id);
        if (!draft || edit.trackIds.length === 0) break;
        draft.trackIds.push(...edit.trackIds);
        touch(draft, true);
        break;
      }
      case "remove": {
        const draft = drafts.get(edit.id);
        if (!draft) break;
        const index = draft.trackIds[edit.position] === edit.trackId ? edit.position : draft.trackIds.indexOf(edit.trackId);
        if (index < 0) break;
        draft.trackIds.splice(index, 1);
        touch(draft, true);
        break;
      }
      case "like": {
        if (edit.liked) {
          const draft = liked();
          if (draft.trackIds.includes(edit.trackId)) break;
          draft.trackIds.push(edit.trackId);
          touch(draft, true);
        } else {
          const draft = drafts.get(PARROT_LIKED_PLAYLIST_ID);
          if (!draft?.trackIds.includes(edit.trackId)) break;
          draft.trackIds = draft.trackIds.filter((id) => id !== edit.trackId);
          touch(draft, true);
        }
        break;
      }
    }
  }

  const createdAt = new Date(now).toISOString();
  const meta = () => ({ id: context.newId(), createdAt });
  const ops: ParrotLibraryOp[] = [];
  for (const id of deleted) ops.push(createParrotOp("playlist.delete", { id }, meta()));
  for (const draft of drafts.values()) {
    if (draft.rowChanged) ops.push(createParrotOp("playlist.upsert", draft.row, meta()));
    if (draft.tracksChanged) ops.push(createParrotOp("playlist_tracks.set", { playlistId: draft.row.id, trackIds: draft.trackIds }, meta()));
  }
  return ops;
};

/** The playlists as they will be after `edits`, for showing a change before the save finishes. */
export const applyPlaylistEditsLocally = (
  playlists: readonly ParrotPlaylist[],
  edits: readonly ParrotPlaylistEdit[],
  now: number
): ParrotPlaylist[] => {
  const ops = parrotPlaylistEditOps(playlists, edits, { now, newId: () => "local" });
  const rows = new Map(playlists.map((playlist) => [playlist.id, { row: { id: playlist.id, name: playlist.name, createdAt: playlist.createdAt, updatedAt: playlist.updatedAt }, trackIds: playlist.trackIds }]));
  for (const op of ops) {
    if (op.type === "playlist.delete") rows.delete(op.payload.id);
    else if (op.type === "playlist.upsert") rows.set(op.payload.id, { row: op.payload, trackIds: rows.get(op.payload.id)?.trackIds ?? [] });
    else if (op.type === "playlist_tracks.set") {
      const entry = rows.get(op.payload.playlistId);
      if (entry) entry.trackIds = op.payload.trackIds;
    }
  }
  const list = [...rows.values()];
  return buildParrotPlaylists(
    list.map((entry) => entry.row),
    list.flatMap((entry) => entry.trackIds.map((trackId) => ({ playlistId: entry.row.id, trackId })))
  );
};
