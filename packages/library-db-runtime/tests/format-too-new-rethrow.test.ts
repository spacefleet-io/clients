/**
 * @test-id LIB-FORMAT-TOO-NEW-RETHROW-001
 * @level source-contract
 * @bugfix format-too-new-swallowed-by-cache-fallback
 * @regression-proof
 *
 * Pre-fix `LibraryDb.open`'s cache-source branch wrapped the constructor
 * call in a try/catch that, on ANY error, cleared the local cache and
 * retried the open recursively. That swallowed `LibraryFormatTooNewError`
 * thrown by the constructor's per-group `initialize<Group>Db →
 * runMigrations` calls. The recursive `open` then re-resolved to
 * `pickBlob: "unavailable"`, which the renderer surfaces as the generic
 * "Library unavailable" copy — hiding the typed error from
 * `parseLibraryFormatTooNew` and the blocking `LibraryFormatTooNewModal`.
 *
 * Surfaced in commit `bb6b1bcb`'s LibraryFormatTooNewModal E2E: the
 * test had to use a main-process IPC override as a workaround because
 * the seeded `library.core.sqlite` with `PRAGMA user_version = 999`
 * never reached the renderer as a format-too-new error.
 *
 * Behavioral test of this catch is difficult: the constructor's
 * pre-migration code path (splitGroupFromLegacy, ensureLibrarySchema)
 * throws first on a too-skinny synthetic SQLite file, before
 * runMigrations can produce the typed error. A round-trip integration
 * test would need a fully-populated per-group SQLite with a too-new
 * user_version, which duplicates the migration-runner suite at
 * `packages/library-db-definition/tests/compatibility.test.ts`.
 *
 * Pin the contract textually instead: the catch block at the
 * cache-source branch of `LibraryDb.open` MUST check for
 * `LibraryFormatTooNewError` and rethrow before clearing the cache.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const SOURCE_PATH = resolve(import.meta.dir, "..", "src", "libraryDb.ts");

// Suite-id: format-too-new-rethrow
// Source-contract suite; dump the discovered catch region and indices so a
// regression makes the drift visible without re-grepping the file.
const dumpRethrowSnapshot = (
  label: string,
  ctx: {
    sourceLen?: number;
    catchRegion?: string;
    rethrowIndex?: number;
    clearIndex?: number;
    hasInstanceof?: boolean;
    hasImport?: boolean;
  },
) => {
  try {
    console.error(`=== [format-too-new-rethrow:${label}] snapshot ===`);
    console.error(`source path=${SOURCE_PATH}`);
    if (ctx.sourceLen !== undefined) console.error(`source length=${ctx.sourceLen} bytes`);
    if (ctx.catchRegion !== undefined) {
      console.error(`catch region (first 500 chars):\n${ctx.catchRegion.slice(0, 500)}`);
    }
    if (ctx.rethrowIndex !== undefined) console.error(`rethrow index=${ctx.rethrowIndex}`);
    if (ctx.clearIndex !== undefined) console.error(`clearLocalCache index=${ctx.clearIndex}`);
    if (ctx.hasInstanceof !== undefined) console.error(`contains instanceof check=${ctx.hasInstanceof}`);
    if (ctx.hasImport !== undefined) console.error(`contains named import=${ctx.hasImport}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("LibraryDb.open — cache-fallback catch must rethrow LibraryFormatTooNewError", () => {
  it("@bugfix @regression-proof the cache-source try/catch in LibraryDb.open contains the instanceof rethrow", () => {
    console.info(`[format-too-new-rethrow:read] reading ${SOURCE_PATH}`);
    const source = readFileSync(SOURCE_PATH, "utf8");
    console.info(`[format-too-new-rethrow:read] source length=${source.length} bytes`);

    // Locate the cache-fallback catch block. The pre-fix shape was a bare
    // `} catch (error) {` immediately followed by `await LibraryDb.clearLocalCache(account);`.
    // The post-fix shape interposes an `instanceof LibraryFormatTooNewError`
    // check + rethrow BEFORE the clear.
    const catchRegion = source.match(
      /\} catch \(error\) \{[\s\S]*?await LibraryDb\.clearLocalCache\(account\);/,
    )?.[0] ?? "";
    console.info(
      `[format-too-new-rethrow:match] catch region length=${catchRegion.length} ` +
        `has-instanceof=${catchRegion.includes("error instanceof LibraryFormatTooNewError")} ` +
        `has-throw=${catchRegion.includes("throw error")}`,
    );

    const rethrowIndex = catchRegion.indexOf("throw error");
    const clearIndex = catchRegion.indexOf("await LibraryDb.clearLocalCache(account)");

    try {
      expect(catchRegion, "cache-fallback catch must be present").toBeTruthy();
      expect(catchRegion).toContain("error instanceof LibraryFormatTooNewError");
      expect(catchRegion).toContain("throw error");
      // Ordering matters: the rethrow must come BEFORE the cache clear.
      expect(rethrowIndex).toBeGreaterThan(-1);
      expect(clearIndex).toBeGreaterThan(-1);
      expect(rethrowIndex).toBeLessThan(clearIndex);
    } catch (err) {
      console.error(`[format-too-new-rethrow:rethrow] assertion failed`);
      dumpRethrowSnapshot("rethrow-failure", {
        sourceLen: source.length,
        catchRegion,
        rethrowIndex,
        clearIndex,
        hasInstanceof: catchRegion.includes("error instanceof LibraryFormatTooNewError"),
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof LibraryFormatTooNewError is imported in libraryDb.ts (rethrow site needs it in scope)", () => {
    console.info(`[format-too-new-rethrow:import] re-reading source to verify import`);
    const source = readFileSync(SOURCE_PATH, "utf8");
    // The class is re-exported at top-of-file via the @space/library-db-definition
    // barrel. The instanceof check depends on a named import being in scope.
    const importMatch = source.match(
      /import\s*\{[\s\S]*?LibraryFormatTooNewError[\s\S]*?\}\s*from\s*"@space\/library-db-definition\/compatibility"/,
    );
    console.info(
      `[format-too-new-rethrow:import] named-import found=${importMatch !== null}`,
    );
    try {
      expect(source).toMatch(/import\s*\{[\s\S]*?LibraryFormatTooNewError[\s\S]*?\}\s*from\s*"@space\/library-db-definition\/compatibility"/);
    } catch (err) {
      console.error(`[format-too-new-rethrow:import] assertion failed`);
      dumpRethrowSnapshot("import-failure", {
        sourceLen: source.length,
        hasImport: importMatch !== null,
      });
      throw err;
    }
  });
});
