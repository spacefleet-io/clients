# @space/parrot-library-db-definition

Parrot's music **library DB definition**: the SQLite schema inside the encrypted
library snapshot that Parrot publishes through `/library/*` with `x-space-app: parrot`.

## Scope
- Drizzle schema (`schema.ts`) and the table → group manifest (`manifest.ts`).
- DDL and the `PRAGMA user_version` migration steps (`migrations.ts`), as plain SQL so
  any SQLite driver (bun:sqlite, React Native) can run them.
- The op set and its SQL generator (`ops.ts`).

## Non-goals
- No network, crypto or snapshot transport: `@space/library-db-runtime/snapshotTransport`
  publishes and opens the snapshot for any app.

## Audio storage
A song's original file is stored whole (PAR-FMT-01), cut into 1 MiB plaintext chunks, each its
own SFV1 media object. `track_file_chunks` maps a byte offset to the chunk object holding it.

## Tests
- `bun run --cwd packages/parrot-library-db-definition test`
