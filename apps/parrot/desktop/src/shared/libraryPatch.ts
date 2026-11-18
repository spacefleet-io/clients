import type { ParrotLibrary } from "./ipc";

type Row = { id: string };
/** What changed in one of the library's lists: rows new, changed or moved (each after the row before it, null: first), and rows gone. */
export type ParrotListPatch<T extends Row> = { rows: Array<{ row: T; after: string | null }>; removed: string[] };
/**
 * What a publish changed in the library the window shows (#2509): only the artists, albums, songs and playlists that
 * are new, changed or moved, so the window updates them in place instead of reading the whole library again.
 */
export type ParrotLibraryPatch = {
  /** The library version the patch applies to; a window showing another one reads the library instead. */
  baseVersion: number | null;
  snapshotVersion: number | null;
  artists: ParrotListPatch<ParrotLibrary["artists"][number]>;
  albums: ParrotListPatch<ParrotLibrary["albums"][number]>;
  tracks: ParrotListPatch<ParrotLibrary["tracks"][number]>;
  playlists: ParrotListPatch<ParrotLibrary["playlists"][number]>;
};

const applyList = <T extends Row>(list: readonly T[], patch: ParrotListPatch<T>): T[] => {
  if (!patch.rows.length && !patch.removed.length) return list as T[];
  const gone = new Set([...patch.removed, ...patch.rows.map(({ row }) => row.id)]);
  const next = list.filter((row) => !gone.has(row.id));
  for (const { row, after } of patch.rows) next.splice(after === null ? 0 : next.findIndex((other) => other.id === after) + 1, 0, row);
  return next;
};

const sameIds = (a: readonly Row[], b: readonly Row[]) => a.length === b.length && a.every((row, index) => row.id === b[index].id);

/** The rows of `after` that are new, changed or have another row before them than in `before`, and the ids gone. */
const diffList = <T extends Row>(before: readonly T[], after: readonly T[]): ParrotListPatch<T> => {
  const old = new Map(before.map((row, index) => [row.id, { json: JSON.stringify(row), previous: index > 0 ? before[index - 1].id : null }]));
  const kept = new Set(after.map((row) => row.id));
  const patch: ParrotListPatch<T> = {
    rows: after.flatMap((row, index) => {
      const previous = index > 0 ? after[index - 1].id : null;
      const was = old.get(row.id);
      return was && was.previous === previous && was.json === JSON.stringify(row) ? [] : [{ row, after: previous }];
    }),
    removed: before.filter((row) => !kept.has(row.id)).map((row) => row.id),
  };
  // A move the rows above cannot say (rows swapped around ones that stayed) sends the whole list instead.
  return sameIds(applyList(before, patch), after) ? patch : { rows: after.map((row, index) => ({ row, after: index > 0 ? after[index - 1].id : null })), removed: before.map((row) => row.id) };
};

/** What turns `before` into `after`. */
export const diffParrotLibrary = (before: ParrotLibrary, after: ParrotLibrary): ParrotLibraryPatch => ({
  baseVersion: before.snapshotVersion,
  snapshotVersion: after.snapshotVersion,
  artists: diffList(before.artists, after.artists),
  albums: diffList(before.albums, after.albums),
  tracks: diffList(before.tracks, after.tracks),
  playlists: diffList(before.playlists, after.playlists),
});

/** `library` with `patch` applied; the lists nothing changed in stay the same objects. */
export const applyParrotLibraryPatch = (library: ParrotLibrary, patch: ParrotLibraryPatch): ParrotLibrary => ({
  snapshotVersion: patch.snapshotVersion,
  artists: applyList(library.artists, patch.artists),
  albums: applyList(library.albums, patch.albums),
  tracks: applyList(library.tracks, patch.tracks),
  playlists: applyList(library.playlists, patch.playlists),
});

/** How many rows a patch carries, for the log. */
export const parrotLibraryPatchSize = (patch: ParrotLibraryPatch) =>
  [patch.artists, patch.albums, patch.tracks, patch.playlists].reduce((sum, list) => sum + list.rows.length + list.removed.length, 0);
