/**
 * Writing found lyrics into the user's own stored file (PAR-LYR-01, PAR-META-04). A song whose file carried no
 * lyrics and whose words were found by the lookup gets them in its file's tags too, so the file keeps them wherever
 * it goes after a download. The stored original is opened on the user's computer (the files are sealed with the
 * library key, so this never happens on a server), the lyrics are added to its tags (`writeParrotLyricsTag`), and it
 * is sealed and stored again as new chunks under the same file id. The caller publishes the returned op, then
 * removes the old chunks (or the new ones when the publish failed).
 *
 * Only originals are rewritten; light copies are left as they are (the library's lyrics are what every app shows).
 * A file whose lyrics came from the file itself (`source = 'file'`) is never touched, and a file found to carry
 * lyrics after all is left as it is too. The new chunks' names hold `/lyrics-`, which marks a file as done.
 */
import { createParrotOp, type ParrotLibraryOp, type TrackFileChunkRow, type TrackFileRow } from "@space/parrot-library-db-definition";
import type { ParrotChunkLoader } from "@space/parrot-core";
import { sha256Hex } from "./ids";
import { uploadParrotFile, type ParrotImportTransport } from "./importer";
import type { ParrotLibraryDb } from "./library";
import { PARROT_LYRICS_TAG_CONTAINERS, writeParrotLyricsTag } from "./lyricsTags";

/** The part of a rewritten file's chunk names that marks it as holding our lyrics. */
export const PARROT_LYRICS_FILE_MARK = "/lyrics-";

/**
 * Original files still waiting for their song's found lyrics: words from the lookup (not the file's own, not the
 * "no lyrics" row), in a container whose tags Parrot writes, and not rewritten yet.
 */
export const PARROT_LYRICS_FILE_PENDING_SQL = `SELECT f.id AS fileId FROM track_files f JOIN lyrics l ON l.track_id = f.track_id
  WHERE f.light_copy = 0 AND l.source NOT IN ('file', 'none') AND (l.synced IS NOT NULL OR l.plain IS NOT NULL)
    AND f.container IN (${PARROT_LYRICS_TAG_CONTAINERS.map((container) => `'${container}'`).join(", ")})
    AND NOT EXISTS (SELECT 1 FROM track_file_chunks c WHERE c.track_file_id = f.id AND c.object_key LIKE '%${PARROT_LYRICS_FILE_MARK}%')
  ORDER BY f.track_id, f.id`;

export const listParrotLyricsFilesPending = (db: ParrotLibraryDb): string[] =>
  (db.prepare(PARROT_LYRICS_FILE_PENDING_SQL).all() as Array<{ fileId: string }>).map((row) => row.fileId);

type StoredFile = TrackFileRow & { chunks: TrackFileChunkRow[]; synced: string | null; plain: string | null };

const readStoredFile = (db: ParrotLibraryDb, fileId: string): StoredFile | null => {
  const row = db
    .prepare(
      `SELECT f.id, f.track_id AS trackId, f.codec, f.container, f.mime, f.lossless, f.bitrate_kbps AS bitrateKbps,
              f.sample_rate AS sampleRate, f.size_bytes AS sizeBytes, f.light_copy AS lightCopy, f.created_at AS createdAt,
              l.synced, l.plain, l.source
       FROM track_files f LEFT JOIN lyrics l ON l.track_id = f.track_id WHERE f.id = ?`
    )
    .get(fileId) as (Record<string, unknown> & { source: string | null }) | undefined;
  if (!row) return null;
  const chunks = db
    .prepare("SELECT idx, object_key AS objectKey, plain_offset AS plainOffset, plain_size AS plainSize FROM track_file_chunks WHERE track_file_id = ? ORDER BY idx")
    .all(fileId) as TrackFileChunkRow[];
  return {
    id: String(row.id),
    trackId: String(row.trackId),
    codec: String(row.codec),
    container: String(row.container),
    mime: String(row.mime),
    lossless: Boolean(row.lossless),
    bitrateKbps: (row.bitrateKbps as number | null) ?? null,
    sampleRate: (row.sampleRate as number | null) ?? null,
    sizeBytes: Number(row.sizeBytes),
    lightCopy: Boolean(row.lightCopy),
    createdAt: Number(row.createdAt),
    chunks,
    synced: row.source === "file" || row.source === "none" ? null : ((row.synced as string | null) ?? null),
    plain: row.source === "file" || row.source === "none" ? null : ((row.plain as string | null) ?? null),
  };
};

export type ParrotLyricsIntoFile =
  | { kind: "written"; op: ParrotLibraryOp; oldObjectKeys: string[]; newObjectKeys: string[]; sizeBytes: number }
  | { kind: "skipped"; reason: string };

/** Whether `file` (as read at write time) is still the one in `db`: same chunks, so the op can be replayed on it. */
export const parrotLyricsFileStillCurrent = (db: ParrotLibraryDb, fileId: string, oldObjectKeys: readonly string[]): boolean => {
  const keys = (db.prepare("SELECT object_key AS objectKey FROM track_file_chunks WHERE track_file_id = ? ORDER BY idx").all(fileId) as Array<{ objectKey: string }>).map(
    (row) => row.objectKey
  );
  return keys.length === oldObjectKeys.length && keys.every((key, i) => key === oldObjectKeys[i]);
};

/** Opens one stored original, adds its song's found lyrics to its tags and stores it again (see the module comment). */
export const writeParrotLyricsIntoFile = async (
  db: ParrotLibraryDb,
  fileId: string,
  deps: {
    token: string;
    userId: string;
    libraryKeyBase64: string;
    clientType: string;
    load: ParrotChunkLoader;
    upload: ParrotImportTransport["upload"];
    openUploadSession?: ParrotImportTransport["openUploadSession"];
    now: number;
    newId: () => string;
    log?: (line: string) => void;
    signal?: AbortSignal;
  }
): Promise<ParrotLyricsIntoFile> => {
  const file = readStoredFile(db, fileId);
  if (!file) return { kind: "skipped", reason: "no such file" };
  if (file.lightCopy) return { kind: "skipped", reason: "a light copy" };
  if (file.chunks.some((chunk) => chunk.objectKey.includes(PARROT_LYRICS_FILE_MARK))) return { kind: "skipped", reason: "already written" };
  const words = file.synced ?? file.plain;
  if (!words) return { kind: "skipped", reason: "no found lyrics" };
  const parts: Uint8Array[] = [];
  for (const chunk of file.chunks) {
    deps.signal?.throwIfAborted();
    parts.push(await deps.load(chunk));
  }
  const original = Buffer.concat(parts);
  if (original.length !== file.sizeBytes) return { kind: "skipped", reason: `read ${original.length} bytes, expected ${file.sizeBytes}` };
  const written = writeParrotLyricsTag(new Uint8Array(original), file.container, words);
  if (written.kind === "has-lyrics") return { kind: "skipped", reason: "the file has lyrics of its own" };
  if (written.kind === "unsupported") return { kind: "skipped", reason: written.reason };
  const hash = sha256Hex(written.bytes);
  const chunks = await uploadParrotFile({
    token: deps.token,
    userId: deps.userId,
    libraryKey: Buffer.from(deps.libraryKeyBase64, "base64"),
    fileId,
    fileHash: hash,
    keyBase: `${fileId}${PARROT_LYRICS_FILE_MARK}${hash.slice(0, 16)}`,
    bytes: written.bytes,
    clientType: deps.clientType,
    upload: deps.upload,
    openUploadSession: deps.openUploadSession,
    signal: deps.signal,
  });
  const { chunks: oldChunks, synced: _synced, plain: _plain, ...row } = file;
  deps.log?.(`[lyrics:file] ${fileId}: ${file.container} ${file.sizeBytes} -> ${written.bytes.length} bytes, ${chunks.length} chunk(s)`);
  return {
    kind: "written",
    op: createParrotOp(
      "track_file.upsert",
      { file: { ...row, sizeBytes: written.bytes.length }, chunks },
      { id: deps.newId(), createdAt: new Date(deps.now).toISOString() }
    ),
    oldObjectKeys: oldChunks.map((chunk) => chunk.objectKey),
    newObjectKeys: chunks.map((chunk) => chunk.objectKey),
    sizeBytes: written.bytes.length,
  };
};
