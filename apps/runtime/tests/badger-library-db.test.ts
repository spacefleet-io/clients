import { describe, expect, it, vi } from "vitest";
import { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import { runtimeCommandResponseSchema } from "@space/runtime-contracts/envelope";

const dumpBadgerDbSnapshot = (label: string, ctx: { response?: unknown; service?: BadgerLibraryDbService | null }) => {
  try {
    console.error(`=== [badger-library-db:${label}] snapshot ===`);
    if (ctx.service) {
      console.error(
        `service.isOpen=${ctx.service.isOpen()} version=${ctx.service.getVersion()} datasetStatus=${JSON.stringify(ctx.service.getDatasetStatus())}`,
      );
    }
    if (ctx.response !== undefined) {
      console.error(`response=${JSON.stringify(ctx.response, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("BadgerLibraryDbService [badger-library-db]", () => {
  it("reports not open before open is called", () => {
    console.info(`[badger-library-db:initial-state] inspecting fresh service before open()`);
    const service = new BadgerLibraryDbService();
    try {
      expect(service.isOpen()).toBe(false);
      expect(service.getSnapshot()).toBeNull();
      expect(service.getVersion()).toBe(0);
      expect(service.getDatasetStatus()).toBeNull();
    } catch (err) {
      dumpBadgerDbSnapshot("initial-state-failure", { service });
      throw err;
    }
  });

  it("call throws when DB is not open", async () => {
    console.info(`[badger-library-db:call-not-open] expecting LIBRARY_DB_NOT_OPEN on listMedia call`);
    const service = new BadgerLibraryDbService();
    try {
      await expect(service.call("listMedia")).rejects.toThrow("LIBRARY_DB_NOT_OPEN");
    } catch (err) {
      dumpBadgerDbSnapshot("call-not-open-failure", { service });
      throw err;
    }
  });

  it("close is safe to call when not open", () => {
    console.info(`[badger-library-db:close-noop] close() on fresh service must not throw`);
    const service = new BadgerLibraryDbService();
    expect(() => service.close()).not.toThrow();
  });

  it("flush is safe to call when not open", async () => {
    console.info(`[badger-library-db:flush-noop] flush() on fresh service resolves undefined`);
    const service = new BadgerLibraryDbService();
    await expect(service.flush()).resolves.toBeUndefined();
  });
});

describe("badger.db.* command dispatch [badger-library-db-dispatch]", () => {
  it("status command reports open state", async () => {
    console.info(`[badger-library-db-dispatch:status] badger.db.status with no prior open should report open=false version=0`);
    // Import the module to test command routing
    const { BadgerModule } = await import("../src/modules/badger");
    const mod = new BadgerModule();
    const result = await mod.execute({
      requestId: "test-1",
      module: "badger",
      command: "badger.db.status",
      payload: {},
    });
    try {
      expect(result.response.ok).toBe(true);
      expect(result.response.result).toMatchObject({ open: false, version: 0 });
    } catch (err) {
      dumpBadgerDbSnapshot("status-failure", { response: result.response });
      throw err;
    }
  });

  it("call command fails when DB not open", async () => {
    console.info(`[badger-library-db-dispatch:call-not-open] expect badger.db.call→error with LIBRARY_DB_NOT_OPEN`);
    const { BadgerModule } = await import("../src/modules/badger");
    const mod = new BadgerModule();
    const result = await mod.execute({
      requestId: "test-2",
      module: "badger",
      command: "badger.db.call",
      payload: { method: "listMedia", args: [] },
    });
    try {
      expect(result.response.ok).toBe(false);
      expect(result.response.error?.message).toContain("LIBRARY_DB_NOT_OPEN");
    } catch (err) {
      dumpBadgerDbSnapshot("call-not-open-dispatch-failure", { response: result.response });
      throw err;
    }
  });

  it("close command succeeds even when not open", async () => {
    console.info(`[badger-library-db-dispatch:close] badger.db.close should always succeed`);
    const { BadgerModule } = await import("../src/modules/badger");
    const mod = new BadgerModule();
    const result = await mod.execute({
      requestId: "test-3",
      module: "badger",
      command: "badger.db.close",
      payload: {},
    });
    try {
      expect(result.response.ok).toBe(true);
      expect(result.response.result).toMatchObject({ closed: true });
    } catch (err) {
      dumpBadgerDbSnapshot("close-failure", { response: result.response });
      throw err;
    }
  });

  it("snapshot command fails when DB not open", async () => {
    console.info(`[badger-library-db-dispatch:snapshot-not-open] badger.db.snapshot should error "not open"`);
    const { BadgerModule } = await import("../src/modules/badger");
    const mod = new BadgerModule();
    const result = await mod.execute({
      requestId: "test-4",
      module: "badger",
      command: "badger.db.snapshot",
      payload: {},
    });
    try {
      expect(result.response.ok).toBe(false);
      expect(result.response.error?.message).toContain("not open");
    } catch (err) {
      dumpBadgerDbSnapshot("snapshot-not-open-failure", { response: result.response });
      throw err;
    }
  });

  it("open command requires token and keyBase64", async () => {
    console.info(`[badger-library-db-dispatch:open-validates] badger.db.open with empty payload must surface "token" error`);
    const { BadgerModule } = await import("../src/modules/badger");
    const mod = new BadgerModule();
    const result = await mod.execute({
      requestId: "test-5",
      module: "badger",
      command: "badger.db.open",
      payload: {},
    });
    try {
      expect(result.response.ok).toBe(false);
      expect(result.response.error?.message).toContain("token");
    } catch (err) {
      dumpBadgerDbSnapshot("open-validates-failure", { response: result.response });
      throw err;
    }
  });

  /**
   * @bugfix offline-mode-library-unavailable-2026-06-04
   * @regression-proof Reported: "I just started the app without the dev stack
   *   running and just have a 'library unavailable', not my offline one." The
   *   runtime had NO local-only open command — the desktop proxy delegated
   *   offline opens to the remote `badger.db.open`, which needs the backend, so
   *   it 400'd offline. These two tests pin (1) the dedicated `badger.db.open_local`
   *   command exists + validates its payload, and (2) it routes to the local-only
   *   `libraryDbService.openLocal` (NOT the remote `open`). Pre-fix, dispatch
   *   returned `invalid_command` ("Unsupported badger command") and there was no
   *   `openLocal` to route to.
   */
  it("[@bugfix][@regression-proof] open_local command is registered and requires token and keyBase64", async () => {
    console.info(`[badger-library-db-dispatch:open-local-validates] badger.db.open_local with empty payload must surface "token" (NOT invalid_command)`);
    const { BadgerModule } = await import("../src/modules/badger");
    const mod = new BadgerModule();
    const result = await mod.execute({
      requestId: "test-open-local-validate",
      module: "badger",
      command: "badger.db.open_local",
      payload: {},
    });
    try {
      expect(result.response.ok).toBe(false);
      // Pre-fix this was `invalid_command` ("Unsupported badger command:
      // badger.db.open_local") because the command was not dispatched at all.
      expect(result.response.error?.code).not.toBe("invalid_command");
      expect(result.response.error?.message).toContain("token");
    } catch (err) {
      dumpBadgerDbSnapshot("open-local-validates-failure", { response: result.response });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] open_local routes to libraryDbService.openLocal and never the remote open", async () => {
    console.info(`[badger-library-db-dispatch:open-local-routes] spying openLocal+open; open_local must call openLocal only`);
    const { BadgerModule } = await import("../src/modules/badger");
    const mod = new BadgerModule();

    // Stub both opens so neither touches real SQLite or the backend.
    const openLocalSpy = vi
      .spyOn(mod.libraryDbService, "openLocal")
      .mockResolvedValue({ version: 7, mediaCount: 3 });
    const remoteOpenSpy = vi
      .spyOn(mod.libraryDbService, "open")
      .mockResolvedValue({ version: 0, mediaCount: 0 });

    const result = await mod.execute({
      requestId: "test-open-local-routes",
      module: "badger",
      command: "badger.db.open_local",
      payload: { token: "tok", keyBase64: "a".repeat(44), userId: "user-dispatch" },
    });

    try {
      console.info(
        `[badger-library-db-dispatch:open-local-routes] openLocal.calls=${openLocalSpy.mock.calls.length} remoteOpen.calls=${remoteOpenSpy.mock.calls.length} ok=${result.response.ok}`,
      );
      expect(result.response.ok).toBe(true);
      // The local-only primitive must be used with the forwarded token/key and account...
      expect(openLocalSpy).toHaveBeenCalledWith("tok", "a".repeat(44), { userId: "user-dispatch" });
      // ...and the REMOTE open (which needs the backend) must NOT be called.
      expect(remoteOpenSpy).not.toHaveBeenCalled();
      // Emits the same db_opened event so the renderer hydrates offline content.
      expect(result.event).toMatchObject({ channel: "library", event: "library.db_opened" });
    } catch (err) {
      dumpBadgerDbSnapshot("open-local-routes-failure", { response: result.response, service: mod.libraryDbService });
      throw err;
    } finally {
      openLocalSpy.mockRestore();
      remoteOpenSpy.mockRestore();
    }
  });

  /**
   * @bugfix badger-db-call-invalid-response-envelope
   * @regression-proof Library-DB methods that return void (e.g. `setSyncEnabled`)
   *   used to leak `result: undefined` into the envelope. `JSON.stringify` strips
   *   undefined keys, so the wire body became `{requestId, ok, error}` — and the
   *   desktop runtime-client's Zod `safeParse` rejected it because `z.unknown()`
   *   is `nonoptional` in Zod 4. This pinned the case where `libraryDbService.call`
   *   resolves to `undefined`: the envelope must still keep `result` (as `null`)
   *   so the post-JSON wire body parses against `runtimeCommandResponseSchema`.
   */
  it("badger.db.call returns a wire-parseable envelope when the method resolves to undefined", async () => {
    console.info(`[badger-library-db-dispatch:void-result-envelope] spying setSyncEnabled→undefined, asserting envelope shape`);
    const { BadgerModule } = await import("../src/modules/badger");
    const mod = new BadgerModule();

    // Stub libraryDbService.call to mimic a void-returning method
    // (e.g. `setSyncEnabled`). Don't open the real SQLite DB — this isolates
    // the envelope-normalization concern from the rest of the pipeline.
    const callSpy = vi
      .spyOn(mod.libraryDbService, "call")
      .mockResolvedValue(undefined);

    const result = await mod.execute({
      requestId: "regression-void-result",
      module: "badger",
      command: "badger.db.call",
      payload: { method: "setSyncEnabled", args: [true] },
    });

    let wireBody: Record<string, unknown> | null = null;
    let parsed: ReturnType<typeof runtimeCommandResponseSchema.safeParse> | null = null;
    try {
      console.info(
        `[badger-library-db-dispatch:void-result-envelope] callSpy.called=${callSpy.mock.calls.length} response.ok=${result.response.ok} result=${JSON.stringify(result.response.result)}`,
      );
      expect(callSpy).toHaveBeenCalledWith("setSyncEnabled", [true]);
      expect(result.response.ok).toBe(true);
      // The fix replaces `undefined` with `null` so JSON.stringify keeps the key.
      expect(result.response.result).toBeNull();

      // Round-trip through JSON.stringify -> JSON.parse to mirror the HTTP wire
      // path, then re-validate with the client-side envelope schema. Pre-fix this
      // assertion would have failed with `result: invalid_type expected nonoptional`.
      wireBody = JSON.parse(JSON.stringify(result.response));
      console.info(`[badger-library-db-dispatch:void-result-envelope] wireBody keys=${JSON.stringify(Object.keys(wireBody ?? {}))}`);
      expect(Object.keys(wireBody!)).toContain("result");
      parsed = runtimeCommandResponseSchema.safeParse(wireBody);
      expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    } catch (err) {
      dumpBadgerDbSnapshot("void-result-envelope-failure", { response: result.response });
      console.error(`wireBody=${JSON.stringify(wireBody, null, 2)}`);
      console.error(`parsed.success=${parsed?.success ?? "n/a"} parsed.error=${parsed && !parsed.success ? JSON.stringify(parsed.error.issues, null, 2) : ""}`);
      throw err;
    }

    callSpy.mockRestore();
  });
});
