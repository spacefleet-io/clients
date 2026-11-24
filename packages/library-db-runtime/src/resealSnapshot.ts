/**
 * STOR-RESEAL-01: a library file the key change publishes refers to the re-sealed copies, never to the old objects
 * the switch deletes. The rewrite runs on a copy of the library's bytes (the snapshot being published), never on the
 * live library: until the server switches, this device still plays the old objects with the old key.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparedResealDb, rewriteBadgerReferences, rewriteParrotReferences, type ReferenceRewrite } from "@space/media-reseal";
import type { SpaceAppId } from "@space/shared/appScope";
import { openDatabase } from "./db";

/** `bytes` (a whole SQLite library file of `appId`) with every reference in `copies` renamed to its copy. */
export const rewriteLibraryBytesForReseal = async (
  bytes: Uint8Array,
  appId: SpaceAppId,
  copies: ReadonlyMap<string, string>
): Promise<{ bytes: Uint8Array; rewrite: ReferenceRewrite }> => {
  if (copies.size === 0) return { bytes, rewrite: { references: 0, byColumn: {} } };
  const dir = mkdtempSync(join(tmpdir(), "sf-reseal-"));
  try {
    const path = join(dir, "library.sqlite");
    writeFileSync(path, bytes);
    const db = openDatabase(path);
    let rewrite: ReferenceRewrite;
    try {
      db.exec("PRAGMA journal_mode = DELETE");
      db.exec("BEGIN");
      try {
        const sql = preparedResealDb(db);
        rewrite = appId === "parrot" ? await rewriteParrotReferences(sql, copies) : await rewriteBadgerReferences(sql, copies);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
    return { bytes: new Uint8Array(readFileSync(path)), rewrite };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
