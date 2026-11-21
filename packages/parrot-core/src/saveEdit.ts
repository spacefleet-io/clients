/**
 * PAR-META-16's save, the same on every Parrot client: each app brings its own way to make the two cover copies,
 * store them, publish the library and remove storage objects; the order and the checks live here.
 */
import type { ParrotLibraryOp } from "@space/parrot-library-db-definition";
import { isParrotCoverCrop, type ParrotCoverCopies, type ParrotCoverCrop } from "./covers";
import { PARROT_EDIT_IDS } from "./ids";
import { planParrotEdit, type ParrotEditTarget, type ParrotLibraryQuery } from "./manage";

/**
 * The picture the user gave the edit dialog (PAR-META-16): a picked or dropped file, or a picture link dropped from a
 * web page; `crop` is the square the user framed on it (PAR-META-22), none for the centre one.
 */
export type ParrotEditCover = ({ kind: "file"; bytes: Uint8Array; mime: string } | { kind: "url"; url: string }) & { crop?: ParrotCoverCrop | null };

export const isParrotEditTarget = (value: unknown): value is ParrotEditTarget => {
  if (typeof value !== "object" || value === null) return false;
  const { kind, id, edit } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id || typeof edit !== "object" || edit === null) return false;
  const fields = edit as Record<string, unknown>;
  const text = (name: string) => typeof fields[name] === "string" && (fields[name] as string).trim().length > 0;
  const yearOk = fields.year === null || typeof fields.year === "number";
  const genreOk = fields.genre === null || typeof fields.genre === "string";
  if (kind === "album") return text("title") && text("albumArtist") && yearOk && genreOk;
  return kind === "track" && text("title") && text("artist") && text("album") && typeof fields.disc === "number" && yearOk && genreOk;
};

export const isParrotEditCover = (value: unknown): value is ParrotEditCover => {
  if (typeof value !== "object" || value === null) return false;
  const { kind, bytes, url, crop } = value as Record<string, unknown>;
  if (crop !== undefined && crop !== null && !isParrotCoverCrop(crop)) return false;
  return (kind === "file" && bytes instanceof Uint8Array) || (kind === "url" && typeof url === "string" && /^https?:\/\//i.test(url));
};

export type ParrotEditSave<Db, Result extends { ok: boolean }> = {
  target: unknown;
  cover: unknown;
  /** The library as it is open now. */
  db: Db;
  query: (db: Db) => ParrotLibraryQuery;
  /** The large (1200 px) and small (500 px) copies of a picture (PAR-COPY-01), cut to `crop`, else its centre square (PAR-META-22); null when the picture cannot be used. */
  makeCoverCopies: (bytes: Uint8Array, crop: ParrotCoverCrop | null) => ParrotCoverCopies | null | Promise<ParrotCoverCopies | null>;
  /** Encrypts and stores one cover copy; returns its object key. */
  storeCover: (bytes: Uint8Array) => Promise<string>;
  /** Applies `ops` and publishes the library; `build` plans the edit again on a newer library after a concurrent publish. */
  publish: (ops: ParrotLibraryOp[], build: (db: Db) => Promise<ParrotLibraryOp[]>) => Promise<Result>;
  deleteObjects: (keys: string[]) => Promise<{ deleted?: number }>;
  newId: () => string;
  now?: () => number;
  fetchPicture?: (url: string) => Promise<Response>;
  log: (message: string) => void;
  fail: (message: string) => void;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const coverBytes = async (cover: ParrotEditCover, fetchPicture: (url: string) => Promise<Response>): Promise<Uint8Array> => {
  if (cover.kind === "file") return new Uint8Array(cover.bytes);
  const response = await fetchPicture(cover.url);
  if (!response.ok) throw new Error(`the picture could not be downloaded (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
};

/**
 * PAR-META-16: saves the user's edits to a song or an album. Ids stay as they are; an album's year and genre go onto
 * its songs. A new cover is stored first (both sizes of PAR-META-07); the copies nothing points at any more are
 * deleted from storage only once the library is published, so a failed publish never leaves the library pointing at a
 * deleted picture. Returns "unchanged" when the edit changes nothing.
 */
export const saveParrotEdit = async <Db, Result extends { ok: boolean }>(
  input: ParrotEditSave<Db, Result>
): Promise<Result | { ok: false; error: string } | "unchanged"> => {
  const { target, cover, log, fail } = input;
  if (!isParrotEditTarget(target)) return { ok: false, error: "invalid edit" };
  let edited: ParrotEditTarget = target;
  if (target.kind === "album" && isParrotEditCover(cover)) {
    try {
      const copies = await input.makeCoverCopies(await coverBytes(cover, input.fetchPicture ?? ((url) => fetch(url))), cover.crop ?? null);
      if (!copies) return { ok: false, error: "the picture could not be read" };
      const coverObjectKey = await input.storeCover(copies.large);
      const coverThumbObjectKey = copies.thumb ? await input.storeCover(copies.thumb) : null;
      log(`[edit] album ${target.id}: new cover stored (${copies.thumb ? "large and small copies" : "one copy"})`);
      edited = { ...target, edit: { ...target.edit, cover: { coverObjectKey, coverThumbObjectKey } } };
    } catch (error) {
      fail(`[edit] album ${target.id}: the new cover could not be stored, nothing changed: ${errorText(error)}`);
      return { ok: false, error: errorText(error) };
    }
  }
  const plan = (db: Db) => planParrotEdit(input.query(db), edited, { now: (input.now ?? Date.now)(), newId: input.newId, ids: PARROT_EDIT_IDS });
  const first = await plan(input.db);
  log(`[edit] ${target.kind} ${target.id}: ${first.ops.length} op(s), ${first.objectKeys.length} stored object(s) left unused`);
  if (first.ops.length === 0) return "unchanged";
  const result = await input.publish(first.ops, async (db) => (await plan(db)).ops);
  if (result.ok && first.objectKeys.length > 0) {
    await input.deleteObjects(first.objectKeys).then(
      (removed) => log(`[edit] storage removed ${removed.deleted ?? 0} unused object(s)`),
      (error) => fail(`[edit] unused objects stay in storage: ${errorText(error)}`)
    );
  }
  return result;
};
