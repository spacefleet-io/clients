// Mock for bun:sqlite — used in vitest environment where Bun builtins aren't available.
// The desktop app delegates to the runtime proxy for DB operations, so this mock
// is only needed to prevent import failures in tests that transitively import library-db-runtime.
export class Database {
  constructor(_filename: string) {}
  exec(_sql: string) {}
  prepare(_sql: string) { return { run: () => {}, get: () => null, all: () => [] }; }
  close() {}
  serialize() { return new Uint8Array(0); }
}
