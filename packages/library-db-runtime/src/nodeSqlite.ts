import { DatabaseSync } from "node:sqlite";

import { setSqliteModules } from "./db";

/**
 * Hands `node:sqlite` to the lazy loader in `db.ts`, for a Node/Electron process without better-sqlite3 (Parrot
 * desktop's main, which keeps its own library through `node:sqlite`). There, the key change's library rewrite
 * (`rewriteLibraryBytesForReseal`, STOR-RESEAL-01) opens SQLite files through `openDatabase`, and the loader's
 * fallback `require("better-sqlite3")` throws "Cannot find module". Only the raw database is provided: `createOrm`
 * (drizzle) throws, as nothing in such a process uses the ORM.
 */
export const registerNodeSqlite = (): void => {
  setSqliteModules({
    Database: DatabaseSync,
    drizzle: () => {
      throw new Error("NODE_SQLITE_NO_ORM");
    },
  });
};
