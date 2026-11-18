// An album page lists the album's songs the user does not have, greyed out (PAR-LIB-05): the album's full tracklist
// is stored at import, and a missing song is a listed one with no owned song at the same disc and number. Shared by
// the desktop and the phone so both pages show the same rows in the same order.
import type { ParrotListedTrack } from "@space/parrot-library-db-definition";

export type { ParrotListedTrack };

type Numbered = { disc: number | null; number: number | null };

const slot = (disc: number | null, number: number | null) => `${disc ?? 1}:${number}`;

/** The listed songs no owned song fills (same disc, same number), in tracklist order; [] when the tracklist is unknown. */
export const missingTracks = (tracklist: ParrotListedTrack[] | null | undefined, owned: readonly Numbered[]): ParrotListedTrack[] => {
  if (!tracklist?.length) return [];
  const have = new Set(owned.filter((track) => track.number != null).map((track) => slot(track.disc, track.number)));
  return tracklist.filter((listed) => !have.has(slot(listed.disc, listed.number)));
};

/** One row of an album page: an owned song (with its index in the playable list) or a missing one. */
export type ParrotAlbumRow<T> = { kind: "owned"; track: T; index: number } | { kind: "missing"; listed: ParrotListedTrack };

/**
 * The album page's rows: the owned songs (already in play order) with the missing ones slotted in by disc and number.
 * Owned songs keep their order and their index into the playable list; songs without a number come last.
 */
export const albumPageRows = <T extends Numbered>(owned: readonly T[], tracklist: ParrotListedTrack[] | null | undefined): ParrotAlbumRow<T>[] => {
  const missing = missingTracks(tracklist, owned);
  // Disc-major position of a row; an unnumbered song sorts after every listed one.
  const position = (disc: number | null, number: number | null) => (number == null ? Number.POSITIVE_INFINITY : (disc ?? 1) * 100_000 + number);
  const rows: ParrotAlbumRow<T>[] = [];
  let next = 0;
  owned.forEach((track, index) => {
    const at = position(track.disc, track.number);
    while (next < missing.length && position(missing[next]!.disc, missing[next]!.number) < at) rows.push({ kind: "missing", listed: missing[next++]! });
    rows.push({ kind: "owned", track, index });
  });
  while (next < missing.length) rows.push({ kind: "missing", listed: missing[next++]! });
  return rows;
};
