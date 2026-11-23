import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

export type MainSqliteDatabase = ReturnType<typeof drizzle>;

export const createOrm = (db: Database.Database) => drizzle(db);

// better-sqlite3 13 resolves its own N-API prebuild; no nativeBinding override.
export const openDatabase = (filename: string) => new Database(filename);
