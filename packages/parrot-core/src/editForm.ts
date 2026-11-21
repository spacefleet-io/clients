// The edit-details form every Parrot app shows for a song or an album (PAR-META-16), also the review of what "Fetch
// metadata" found (PAR-META-18): the fields it holds, how the library's values fill it, which fields the user changed,
// and the edit it saves. Each app only draws it.
import type { ParrotAlbumEdit, ParrotEditTarget, ParrotTrackEdit } from "./manage";

export type ParrotEditFields = {
  title: string;
  /** The song's artist, or the album's album artist. */
  artist: string;
  /** Songs only. */
  album?: string;
  number?: number | null;
  disc?: number;
  year: number | null;
  genre: string | null;
};

/** The current details of a song or an album, for the edit form; null when it is gone. */
export type ParrotEditValues = { kind: "track"; edit: ParrotTrackEdit } | { kind: "album"; edit: Omit<ParrotAlbumEdit, "cover"> } | null;

/** The form filled with a song's or an album's details. A track number of 0 (a file without the tag) is none. */
export const parrotEditFields = (values: NonNullable<ParrotEditValues>): ParrotEditFields =>
  values.kind === "track"
    ? { title: values.edit.title, artist: values.edit.artist, album: values.edit.album, number: values.edit.number || null, disc: values.edit.disc, year: values.edit.year, genre: values.edit.genre }
    : { title: values.edit.title, artist: values.edit.albumArtist, year: values.edit.year, genre: values.edit.genre };

/** A typed number field: a whole number above zero, else none. */
export const parrotEditNumber = (value: string): number | null => {
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** True when the field differs from the library's value (the "Changed" mark); never without library values. */
export const parrotEditFieldChanged = (fields: ParrotEditFields, current: ParrotEditFields | undefined, key: keyof ParrotEditFields): boolean =>
  current !== undefined && (fields[key] ?? null) !== (current[key] ?? null);

/** The edit the form saves for `target` (an album's cover travels beside it). */
export const parrotEditTarget = (target: { kind: "track" | "album"; id: string }, fields: ParrotEditFields): ParrotEditTarget =>
  target.kind === "track"
    ? {
        kind: "track",
        id: target.id,
        edit: { title: fields.title, artist: fields.artist, album: fields.album ?? "", number: fields.number ?? null, disc: fields.disc ?? 1, year: fields.year, genre: fields.genre },
      }
    : { kind: "album", id: target.id, edit: { title: fields.title, albumArtist: fields.artist, year: fields.year, genre: fields.genre } };
