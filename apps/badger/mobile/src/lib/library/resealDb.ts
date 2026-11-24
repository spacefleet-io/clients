/**
 * A react-native-sqlite-storage database as the key change's library rewrite sees it (STOR-RESEAL-01). The driver
 * carries no BLOB bytes (packedChunkRows.ts), so BLOBs are read as `hex()` (`blobsAsHex`) and written as `X'..'`.
 */
import type { ResealSqlDb, ResealSqlRow } from "@space/media-reseal";
import { inlineBlobParams } from "./packedChunkRows";

type ResultRows = { length: number; item(index: number): ResealSqlRow };
/** The one call the rewrite makes: a react-native-sqlite-storage `SQLiteDatabase` is one. */
export type ExecuteSqlDb = { executeSql(sql: string, params?: unknown[]): Promise<ReadonlyArray<{ rows?: ResultRows }>> };

export const sqliteStorageResealDb = (db: ExecuteSqlDb): ResealSqlDb => ({
  blobsAsHex: true,
  all: async (sql, params = []) => {
    const [result] = await db.executeSql(sql, params);
    const out: ResealSqlRow[] = [];
    const rows = result?.rows;
    if (!rows) return out;
    for (let i = 0; i < rows.length; i += 1) out.push(rows.item(i));
    return out;
  },
  run: async (sql, params = []) => {
    const [inlined, kept] = inlineBlobParams(sql, params);
    await db.executeSql(inlined, kept);
  },
});
