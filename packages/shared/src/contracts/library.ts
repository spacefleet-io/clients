import { z } from "zod";

export const ChunkHashSchema = z.string().min(1).max(128).regex(/^[a-fA-F0-9]+$/);

export const LibraryOpEntrySchema = z.object({
  opId: z.string().min(1),
  objectKey: z.string().min(1),
  version: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  size: z.number().int().nonnegative(),
  payloadCiphertext: z.string().min(1).optional(),
});

/**
 * A migration advisory (Part D4) — the operator kill-switch. Lets an operator
 * pause a known-bad schema migration while a fixed build ships, without ever
 * giving the server code execution against the plaintext library. Set via
 * direct SQL on a config row for v1; an admin endpoint is deferred.
 */
export const LibraryMigrationAdvisorySchema = z.object({
  /** Logical group names whose migration clients should hold off applying. */
  holdGroups: z.array(z.string().min(1)),
  /** Human-readable notices surfaced to the client about deprecated formats. */
  deprecationNotices: z.array(
    z.object({
      surface: z.string().min(1),
      message: z.string().min(1),
    })
  ),
});
export type LibraryMigrationAdvisory = z.infer<typeof LibraryMigrationAdvisorySchema>;

export const LibraryOpsResponseSchema = z.object({
  version: z.number().int().nonnegative(),
  snapshotVersion: z.number().int().nonnegative(),
  tooOld: z.boolean(),
  // True when more ops follow this page: `version` is then the last op returned and the device asks again
  // with `since` = that version. False = this response reaches the library's current version. `.default(false)`
  // keeps a pre-paging server's body (no field) valid.
  hasMore: z.boolean().default(false),
  ops: z.array(LibraryOpEntrySchema),
  // Format-versioning surfaces (Parts A/B). `.default(1)` keeps every existing
  // server response and test fixture valid: a body omitting these parses as
  // version 1, which is the only format that has ever shipped.
  storageFormatVersion: z.number().int().positive().default(1),
  opStreamVersion: z.number().int().positive().default(1),
  // The op stream the account's writers move to (LIB-FMT-13): 4 once the account is switched, else 3. Absent on a
  // server from before the switch knob and on non-Badger libraries.
  targetOpStreamVersion: z.number().int().positive().optional(),
  // Optional operator advisory (Part D4) — absent in the common case.
  migrationAdvisory: LibraryMigrationAdvisorySchema.optional(),
});

export type LibraryOpEntry = z.infer<typeof LibraryOpEntrySchema>;
export type LibraryOpsResponse = z.infer<typeof LibraryOpsResponseSchema>;

export const LibrarySnapshotHistoryEntrySchema = z.object({
  snapshotId: z.string().min(1),
  manifestKey: z.string().min(1),
  version: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
});
export type LibrarySnapshotHistoryEntry = z.infer<typeof LibrarySnapshotHistoryEntrySchema>;

/**
 * Who produced a snapshot's `chunkRefs` (PR #143 re-review P1). The API stores
 * it on the snapshot_history entry; the reverse orphan sweep deletes a user's
 * unreferenced chunks only when EVERY live/restorable entry carries a source
 * with `refsVersion >= TRUSTED_CHUNK_REFS_VERSION`. Version 2 = the client
 * guarantees chunkRefs is exactly the chunk set of the published manifest.
 * Mobile builds before 2 could publish a pending snapshot's OLD manifest with
 * the hashes of a re-encrypted file, so their entries (sent without a source)
 * are never trusted.
 */
export const TRUSTED_CHUNK_REFS_VERSION = 2;
export const ChunkRefsSourceSchema = z.object({
  client: z.string().min(1).max(64),
  refsVersion: z.number().int().positive(),
});
export type ChunkRefsSource = z.infer<typeof ChunkRefsSourceSchema>;

export const PutLibraryDbRequestSchema = z.object({
  snapshotId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  manifest: z.string().min(1),
  manifestEncoding: z.literal("base64").default("base64"),
  chunkRefs: z.array(ChunkHashSchema),
  // Absent for clients that cannot vouch for their chunkRefs (see above).
  chunkRefsSource: ChunkRefsSourceSchema.optional(),
  chunkSize: z.number().int().positive(),
  stateHash: z.string().nullish(),
  lastOpId: z.string().nullish(),
  keyProbe: z.string().nullish(),
  // Format versions the publishing client declares (Parts A/B). `.default(1)`
  // keeps pre-versioning request bodies valid; the API rejects a publish whose
  // declared versions are lower than what is stored (downgrade protection).
  storageFormatVersion: z.number().int().positive().default(1),
  opStreamVersion: z.number().int().positive().default(1),
  force: z.boolean().default(false),
});
export type PutLibraryDbRequest = z.infer<typeof PutLibraryDbRequestSchema>;

export const PutLibraryDbResponseSchema = z.object({
  version: z.number().int().nonnegative(),
  snapshotVersion: z.number().int().nonnegative(),
  stateHash: z.string().nullable(),
  lastOpId: z.string().nullable(),
});
export type PutLibraryDbResponse = z.infer<typeof PutLibraryDbResponseSchema>;

export class LibraryContractError extends Error {
  readonly issues: ReadonlyArray<{ path: string; message: string }>;
  constructor(issues: ReadonlyArray<{ path: string; message: string }>) {
    super(`LIBRARY_CONTRACT_INVALID: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.issues = issues;
    this.name = "LibraryContractError";
  }
}

const collectIssues = (error: z.ZodError) =>
  error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));

export const parseLibraryOpsResponse = (value: unknown): LibraryOpsResponse => {
  const result = LibraryOpsResponseSchema.safeParse(value);
  if (result.success) return result.data;
  throw new LibraryContractError(collectIssues(result.error));
};

export const parsePutLibraryDbRequest = (value: unknown): PutLibraryDbRequest => {
  const result = PutLibraryDbRequestSchema.safeParse(value);
  if (result.success) return result.data;
  throw new LibraryContractError(collectIssues(result.error));
};

export const parsePutLibraryDbResponse = (value: unknown): PutLibraryDbResponse => {
  const result = PutLibraryDbResponseSchema.safeParse(value);
  if (result.success) return result.data;
  throw new LibraryContractError(collectIssues(result.error));
};
