# @space/library-db-definition

Shared **library DB definition** package.

## Scope
- Canonical DB schema definitions (`schema.ts`).
- Schema/bootstrap migrations (`migrations.ts`).
- Mobile React Native SQL statement sets (`mobileSql.ts`).
- Pure DB helper utilities (for example op compaction in `opCompaction.ts`).

## Non-goals
- No runtime client orchestration (open/sync/publish/state machine).
- No platform-specific sqlite driver wiring.

Use `@space/library-db-runtime` for runtime DB behavior.

## Tests
- `bun run --cwd packages/library-db-definition test`
