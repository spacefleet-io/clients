/**
 * @test-id RUNTIME-BADGER-LIBRARY-FORMAT-TOO-NEW-001
 * @level unit
 *
 * @why Part D — `libraryDbCommandError` in badger.ts must lift a
 *   `LibraryFormatTooNewError`'s structured fields into the error envelope's
 *   `details` so the renderer can key off `details.kind === "library_format_too_new"`
 *   rather than string-parsing the error message. Without this, a forward-skew
 *   library (newer storage/op-stream/schema version than the build supports)
 *   surfaced to the renderer as a bare `internal_error` with only a message
 *   string — the renderer would have had to parse "LIBRARY_FORMAT_TOO_NEW:
 *   storage observed=2 supported=1" to decide whether to show the blocking
 *   "app too old" modal, fragile coupling that silently breaks on any message
 *   reformat.
 *
 *   The test exercises the round-trip through `BadgerModule.execute()` rather
 *   than calling the private `libraryDbCommandError` directly. `libraryDbService`
 *   is a public property on `BadgerModule`, so we can replace its `open` method
 *   with a spy that throws a controlled `LibraryFormatTooNewError` without
 *   touching any production code.
 *
 *   Both call sites (openLibraryDb + callLibraryDb) are covered.
 */

import { describe, expect, it, vi } from "vitest";
import { BadgerModule } from "../src/modules/badger";
import { LibraryFormatTooNewError } from "@space/library-db-runtime";
import type { RuntimeCommandRequest } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRequest = (
  command: string,
  payload: Record<string, unknown> = {}
): RuntimeCommandRequest => ({
  requestId: "req-test-001",
  module: "badger",
  command,
  payload,
});

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps spy + response state on assertion failure.
// Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpFormatTooNewSnapshot = (
  label: string,
  ctx: {
    surface?: string;
    observed?: number;
    supported?: number;
    response?: unknown;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [library-format-too-new:${label}] snapshot ===`);
    if (ctx.surface !== undefined) {
      console.error(`expectedSurface=${ctx.surface} observed=${ctx.observed} supported=${ctx.supported}`);
    }
    if (ctx.response !== undefined) {
      console.error(`response=\n${JSON.stringify(ctx.response, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("badger.db.open — LibraryFormatTooNewError details round-trip", () => {
  it("storage surface: details carry kind, surface, observed, supported; group absent", async () => {
    console.info(`[library-format-too-new:storage-no-group] injecting LibraryFormatTooNewError surface=storage observed=2 supported=1`);
    const module = new BadgerModule();
    const err = new LibraryFormatTooNewError({
      surface: "storage",
      observed: 2,
      supported: 1,
    });
    vi.spyOn(module.libraryDbService, "open").mockRejectedValueOnce(err);

    const { response } = await module.execute(
      makeRequest("badger.db.open", { token: "tok", keyBase64: "a".repeat(44), userId: "user-a" })
    );
    console.info(`[library-format-too-new:storage-no-group] response.ok=${response.ok} error.code=${response.error?.code} details.kind=${(response.error?.details as { kind?: string })?.kind}`);

    try {
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("internal_error");
      expect(response.error?.details).toMatchObject({
        kind: "library_format_too_new",
        surface: "storage",
        observed: 2,
        supported: 1,
      });
      // `group` must be absent (not present as null/undefined) for a non-schema surface.
      expect(response.error?.details).not.toHaveProperty("group");
    } catch (err) {
      dumpFormatTooNewSnapshot("storage-no-group-failure", {
        surface: "storage",
        observed: 2,
        supported: 1,
        response,
      });
      throw err;
    }
  });

  it("op-stream surface: details carry surface='op-stream', observed, supported; no group", async () => {
    console.info(`[library-format-too-new:op-stream-no-group] injecting LibraryFormatTooNewError surface=op-stream observed=5 supported=1`);
    const module = new BadgerModule();
    const err = new LibraryFormatTooNewError({
      surface: "op-stream",
      observed: 5,
      supported: 1,
    });
    vi.spyOn(module.libraryDbService, "open").mockRejectedValueOnce(err);

    const { response } = await module.execute(
      makeRequest("badger.db.open", { token: "tok", keyBase64: "b".repeat(44), userId: "user-a" })
    );
    console.info(`[library-format-too-new:op-stream-no-group] response.error.details=${JSON.stringify(response.error?.details)}`);

    try {
      expect(response.ok).toBe(false);
      expect(response.error?.details).toMatchObject({
        kind: "library_format_too_new",
        surface: "op-stream",
        observed: 5,
        supported: 1,
      });
      expect(response.error?.details).not.toHaveProperty("group");
    } catch (err) {
      dumpFormatTooNewSnapshot("op-stream-no-group-failure", {
        surface: "op-stream",
        observed: 5,
        supported: 1,
        response,
      });
      throw err;
    }
  });

  it("schema surface with group: details include group", async () => {
    console.info(`[library-format-too-new:schema-with-group] injecting LibraryFormatTooNewError surface=schema group=core observed=3 supported=1`);
    const module = new BadgerModule();
    const err = new LibraryFormatTooNewError({
      surface: "schema",
      observed: 3,
      supported: 1,
      group: "core",
    });
    vi.spyOn(module.libraryDbService, "open").mockRejectedValueOnce(err);

    const { response } = await module.execute(
      makeRequest("badger.db.open", { token: "tok", keyBase64: "c".repeat(44), userId: "user-a" })
    );
    console.info(`[library-format-too-new:schema-with-group] response.error.details=${JSON.stringify(response.error?.details)}`);

    try {
      expect(response.ok).toBe(false);
      expect(response.error?.details).toMatchObject({
        kind: "library_format_too_new",
        surface: "schema",
        observed: 3,
        supported: 1,
        group: "core",
      });
    } catch (err) {
      dumpFormatTooNewSnapshot("schema-with-group-failure", {
        surface: "schema",
        observed: 3,
        supported: 1,
        response,
        extra: { group: "core" },
      });
      throw err;
    }
  });

  it("a generic Error (non-LibraryFormatTooNewError) yields internal_error with no kind in details", async () => {
    console.info(`[library-format-too-new:generic-error-no-kind] injecting plain Error("DECRYPT_FAILED")`);
    const module = new BadgerModule();
    vi.spyOn(module.libraryDbService, "open").mockRejectedValueOnce(
      new Error("DECRYPT_FAILED")
    );

    const { response } = await module.execute(
      makeRequest("badger.db.open", { token: "tok", keyBase64: "d".repeat(44), userId: "user-a" })
    );
    console.info(`[library-format-too-new:generic-error-no-kind] response.error.code=${response.error?.code} message=${response.error?.message}`);

    try {
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("internal_error");
      expect(response.error?.message).toContain("DECRYPT_FAILED");
      // Must NOT have kind — the renderer's `details.kind` check must not trigger.
      expect(response.error?.details?.kind).toBeUndefined();
    } catch (err) {
      dumpFormatTooNewSnapshot("generic-error-no-kind-failure", { response });
      throw err;
    }
  });
});

describe("badger.db.call — LibraryFormatTooNewError details round-trip", () => {
  it("storage surface from callLibraryDb also gets details lifted correctly", async () => {
    console.info(`[library-format-too-new:call-storage] injecting via libraryDbService.call`);
    const module = new BadgerModule();
    const err = new LibraryFormatTooNewError({
      surface: "storage",
      observed: 2,
      supported: 1,
    });
    // callLibraryDb calls libraryDbService.call — spy on that.
    vi.spyOn(module.libraryDbService, "call").mockRejectedValueOnce(err);

    const { response } = await module.execute(
      makeRequest("badger.db.call", { method: "syncFromRemoteIfNewer", args: [] })
    );
    console.info(`[library-format-too-new:call-storage] response.error.details=${JSON.stringify(response.error?.details)}`);

    try {
      expect(response.ok).toBe(false);
      expect(response.error?.details).toMatchObject({
        kind: "library_format_too_new",
        surface: "storage",
        observed: 2,
        supported: 1,
      });
    } catch (err) {
      dumpFormatTooNewSnapshot("call-storage-failure", {
        surface: "storage",
        observed: 2,
        supported: 1,
        response,
      });
      throw err;
    }
  });
});
