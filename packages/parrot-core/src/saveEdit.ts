/**
 * PAR-META-16 and PAR-META-31's save, the same on every Parrot client: each app brings its own way to make the two
 * picture copies, store them, publish the library and remove storage objects; the order and the checks live here.
 */
import type { ParrotLibraryOp } from "@space/parrot-library-db-definition";
import { isParrotCoverCrop, PARROT_COVER_MAX_BYTES, parrotPictureSizeProblem, type ParrotCoverCopies, type ParrotCoverCrop } from "./covers";
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
  if (kind === "artist") return text("name") && (fields.picture === undefined || fields.picture === "automatic");
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

const TOO_LARGE = `picture too large (at most ${PARROT_COVER_MAX_BYTES / 1024 / 1024} MB)`;

/**
 * The picture's bytes, never more than PARROT_COVER_MAX_BYTES read (PAR-META-31): a file over it is refused, a link
 * whose answer declares more is refused before it is read, and one that sends more is cut off as soon as it does.
 */
const coverBytes = async (cover: ParrotEditCover, fetchPicture: (url: string) => Promise<Response>): Promise<Uint8Array> => {
  if (cover.kind === "file") {
    if (cover.bytes.length > PARROT_COVER_MAX_BYTES) throw new Error(TOO_LARGE);
    return new Uint8Array(cover.bytes);
  }
  const response = await fetchPicture(cover.url);
  if (!response.ok) throw new Error(`the picture could not be downloaded (HTTP ${response.status})`);
  if (Number(response.headers.get("content-length") ?? 0) > PARROT_COVER_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error(TOO_LARGE);
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > PARROT_COVER_MAX_BYTES) {
      await reader.cancel();
      throw new Error(TOO_LARGE);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
};

/** Deletes the copies this save stored when the edit is refused, so none is left unused. */
const dropStored = async (input: { deleteObjects: (keys: string[]) => Promise<{ deleted?: number }>; log: (message: string) => void; fail: (message: string) => void }, keys: string[]) => {
  if (keys.length === 0) return;
  await input.deleteObjects(keys).then(
    (removed) => input.log(`[edit] storage removed ${removed.deleted ?? 0} copy(ies) this save had stored`),
    (error) => input.fail(`[edit] copies this save stored stay in storage: ${errorText(error)}`)
  );
};

/**
 * PAR-META-16 / PAR-META-31: saves the user's edits to a song, an album or an artist. Ids stay as they are; an album's
 * year and genre go onto its songs; an artist's new name reaches its albums and songs through the id they point at.
 * A new cover or artist photo is checked against the size caps before it is decoded, cut to its square and re-encoded
 * at the stored sizes (the original is never stored), then stored first (both sizes of PAR-META-07); the copies
 * nothing points at any more are deleted from storage only once the library is published, so a failed publish never
 * leaves the library pointing at a deleted picture, and the copies just stored are deleted when the edit is refused
 * (a failed publish keeps them, it may have reached the server). Returns "unchanged" when the edit changes nothing.
 */
export const saveParrotEdit = async <Db, Result extends { ok: boolean }>(
  input: ParrotEditSave<Db, Result>
): Promise<Result | { ok: false; error: string } | "unchanged"> => {
  const { target, cover, log, fail } = input;
  if (!isParrotEditTarget(target)) return { ok: false, error: "invalid edit" };
  let edited: ParrotEditTarget = target;
  const stored: string[] = [];
  if ((target.kind === "album" || target.kind === "artist") && isParrotEditCover(cover)) {
    const what = target.kind === "album" ? "cover" : "photo";
    try {
      const bytes = await coverBytes(cover, input.fetchPicture ?? ((url) => fetch(url)));
      const problem = parrotPictureSizeProblem(bytes);
      if (problem) {
        fail(`[edit] ${target.kind} ${target.id}: the new ${what} is refused, nothing changed: ${problem}`);
        return { ok: false, error: problem };
      }
      const copies = await input.makeCoverCopies(bytes, cover.crop ?? null);
      if (!copies) return { ok: false, error: "the picture could not be read" };
      const large = await input.storeCover(copies.large);
      stored.push(large);
      const thumb = copies.thumb ? await input.storeCover(copies.thumb) : null;
      if (thumb) stored.push(thumb);
      log(`[edit] ${target.kind} ${target.id}: new ${what} stored (${copies.large.length} bytes${copies.thumb ? `, small copy ${copies.thumb.length} bytes` : ", one copy"})`);
      edited =
        target.kind === "album"
          ? { ...target, edit: { ...target.edit, cover: { coverObjectKey: large, coverThumbObjectKey: thumb } } }
          : { ...target, edit: { ...target.edit, picture: { pictureObjectKey: large, pictureThumbObjectKey: thumb } } };
    } catch (error) {
      fail(`[edit] ${target.kind} ${target.id}: the new ${what} could not be stored, nothing changed: ${errorText(error)}`);
      await dropStored(input, stored);
      return { ok: false, error: errorText(error) };
    }
  }
  const plan = (db: Db) => planParrotEdit(input.query(db), edited, { now: (input.now ?? Date.now)(), newId: input.newId, ids: PARROT_EDIT_IDS });
  const first = await plan(input.db);
  if (first.error) {
    fail(`[edit] ${target.kind} ${target.id}: refused, nothing changed: ${first.error}`);
    await dropStored(input, stored);
    return { ok: false, error: first.error };
  }
  log(`[edit] ${target.kind} ${target.id}: ${first.ops.length} op(s), ${first.objectKeys.length} stored object(s) left unused`);
  if (first.ops.length === 0) {
    await dropStored(input, stored);
    return "unchanged";
  }
  // A newer library the edit no longer fits (an artist of that name arrived meanwhile) publishes nothing: the copies
  // just stored go, and the old picture stays, as the library still points at it. A failed publish keeps them: the
  // server may have taken it before the answer was lost, and a library pointing at a deleted picture is worse than
  // an unused copy.
  let refused: string | undefined;
  const result = await input.publish(first.ops, async (db) => {
    const again = await plan(db);
    refused = again.error;
    if (again.error) fail(`[edit] ${target.kind} ${target.id}: refused on the newer library: ${again.error}`);
    return again.error ? [] : again.ops;
  });
  if (refused) {
    await dropStored(input, stored);
    return { ok: false, error: refused };
  }
  if (!result.ok) return result;
  if (first.objectKeys.length > 0) {
    await input.deleteObjects(first.objectKeys).then(
      (removed) => log(`[edit] storage removed ${removed.deleted ?? 0} unused object(s)`),
      (error) => fail(`[edit] unused objects stay in storage: ${errorText(error)}`)
    );
  }
  return result;
};
