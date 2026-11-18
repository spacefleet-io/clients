# @space/library-db-runtime

Shared **runtime library DB client** package.

## Scope
- `LibraryDb` runtime behavior used by desktop/headless.
- Open local DB, sync encrypted snapshots/ops, apply operations, persist pending state.
- API host/API/crypto/storage/runtime helpers needed by `LibraryDb`.

## Dependencies
- Uses `@space/library-db-definition` for schema + migrations + pure helpers.

## Notes
- This package currently targets desktop/headless runtimes (Node + `better-sqlite3`).
- Mobile keeps a dedicated RN runtime path and progressively shares pure helpers via `@space/library-db-definition`.

## Tests
- `bun run --cwd packages/library-db-runtime test`

## Benchmark
- `bun run bench:library -- --files 100,1000,5000` (repo root) or `bun run --cwd packages/library-db-runtime bench:library -- ...`: wire-byte and per-change-cost benchmark of the library vault on generated libraries. See `bench/README.md`.

## Logging
- `SF_LOG_LEVEL` (default `info`)
- `SF_LOG_PRETTY` (`1` to force pretty logs)
