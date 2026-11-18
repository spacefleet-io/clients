// react-native-sqlite-storage ships no types; the calls Parrot makes (promise mode).
declare module "react-native-sqlite-storage" {
  interface SQLiteDatabase {
    executeSql(
      sql: string,
      params?: unknown[]
    ): Promise<[{ rows: { length: number; item(index: number): Record<string, unknown> }; rowsAffected: number }]>;
    /** Runs the statements (plain SQL, or `[sql, params]`) in one transaction. */
    sqlBatch(statements: (string | [string, unknown[]])[]): Promise<void>;
    close(): Promise<void>;
  }

  namespace SQLite {
    export type SQLiteDatabase = import("react-native-sqlite-storage").SQLiteDatabase;
  }

  interface SQLite {
    openDatabase(params: { name: string; location?: string }): Promise<SQLiteDatabase>;
    enablePromise(enable: boolean): void;
  }

  const SQLite: SQLite;
  export default SQLite;
  export type { SQLiteDatabase };
}

// Inlined at build time by babel-plugin-api-base-url.js; React Native has no `process` otherwise.
declare const process: { env: { PARROT_API_BASE_URL?: string; PARROT_METADATA_TICKETS?: string; EXPO_PUBLIC_METADATA_URL?: string } };
