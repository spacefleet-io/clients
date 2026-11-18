declare module "react-native-sqlite-storage" {
  interface SQLiteDatabase {
    transaction(fn: (tx: SQLiteTransaction) => void): Promise<void>;
    executeSql(
      sql: string,
      params?: unknown[],
    ): Promise<[{ rows: { length: number; item(index: number): Record<string, unknown>; raw(): unknown[][] }; insertId?: number; rowsAffected: number }]>;
    sqlBatch(statements: Array<string | [string, ...unknown[]]>): Promise<void>;
    close(): Promise<void>;
  }

  interface SQLiteTransaction {
    executeSql(
      sql: string,
      params?: unknown[],
      success?: (tx: SQLiteTransaction, results: { rows: { length: number; item(index: number): Record<string, unknown> }; insertId?: number; rowsAffected: number }) => void,
      error?: (tx: SQLiteTransaction, error: Error) => boolean,
    ): void;
  }

  namespace SQLite {
    export type SQLiteDatabase = import("react-native-sqlite-storage").SQLiteDatabase;
  }

  interface SQLite {
    openDatabase(params: {
      name: string;
      location?: string;
      createFromLocation?: number;
    }): Promise<SQLiteDatabase>;
    enablePromise(enable: boolean): void;
    DEBUG(enable: boolean): void;
  }

  const SQLite: SQLite;
  export default SQLite;
  export type { SQLiteDatabase };
}

declare module "base-64" {
  export function decode(input: string): string;
  export function encode(input: string): string;
}

// Private React Native module: wraps a native blob id (created by a native module) as a JS Blob that
// WebSocket.send transfers natively, without the JS-side base64 encode.
declare module "react-native/Libraries/Blob/BlobManager" {
  const BlobManager: {
    createFromOptions(options: { blobId: string; offset: number; size: number }): Blob & { close(): void };
  };
  export default BlobManager;
}
