// @bugfix @regression-proof
//
// Repro for "Add to Library throws RUNTIME_JOBS_AUTH_REQUIRED": the v2 IPC
// handlers stored a stateful backendToken that was only set when something
// actively invoked `onAuthTokenChanged` — typically the playback session,
// not the login flow. Users who clicked "Add to Library" before starting
// playback hit `ensureClient()` with a null token and the IPC threw.
//
// Fix: the `sf-auth-set-token` IPC handler (which the
// renderer's auth.tsx already calls on every token change, including app
// startup) now propagates the token to runtimeJobsIpc as well.
//
// This test pins the textual wiring — the production handler at
// apps/badger/desktop/src/main/index.ts must call setRuntimeJobsBackendToken
// when the auth IPC fires.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { badgerIngestSubmitSourceItemSchema } from "@space/runtime-contracts/badger/ingest";
import path from "node:path";

describe("[@bugfix][@regression-proof] runtime-jobs IPC auth token wiring", () => {
  it("sf-auth-set-token handler propagates the token to runtimeJobsIpc", () => {
    const indexPath = path.resolve(
      import.meta.dirname,
      "..",
      "src",
      "main",
      "index.ts"
    );
    const src = readFileSync(indexPath, "utf8");

    // Find the IPC handler block.
    const handlerStart = src.indexOf(
      'ipcMain.handle("sf-auth-set-token"'
    );
    expect(handlerStart, "handler must exist").toBeGreaterThan(-1);
    const handlerEnd = src.indexOf("});", handlerStart);
    expect(handlerEnd, "handler must close").toBeGreaterThan(handlerStart);
    const handlerBody = src.slice(handlerStart, handlerEnd);

    // The fix: the handler must propagate to setRuntimeJobsBackendToken.
    expect(
      handlerBody.includes("setRuntimeJobsBackendToken"),
      "handler must call setRuntimeJobsBackendToken so v2 ingest sees the token"
    ).toBe(true);
  });

  it("setRuntimeJobsBackendToken stays in sync with ffmpegRuntimeBridge.setBackendToken", () => {
    const indexPath = path.resolve(
      import.meta.dirname,
      "..",
      "src",
      "main",
      "index.ts"
    );
    const src = readFileSync(indexPath, "utf8");

    // Both bridges must be updated by the same auth IPC handler — if a
    // future change drops one, the other should fail too so we catch it.
    const handlerStart = src.indexOf(
      'ipcMain.handle("sf-auth-set-token"'
    );
    const handlerEnd = src.indexOf("});", handlerStart);
    const handlerBody = src.slice(handlerStart, handlerEnd);

    expect(handlerBody.includes("ffmpegRuntimeBridge.setBackendToken")).toBe(
      true
    );
    expect(handlerBody.includes("setRuntimeJobsBackendToken")).toBe(true);
  });
});

describe("[@bugfix][@regression-proof] sf-runtime-jobs-submit-sources forwards audio/subtitle overrides (Bug #4)", () => {
  // Bug #4 walk-1 verifier finding: the renderer + runtime + contract were
  // all correct end-to-end, but the desktop main IPC handler was stripping
  // `audioOverrides` and `subtitleOverrides` between the preload bridge and
  // the runtime command client. The fix forwards both fields. This test
  // pins the textual wiring so a future refactor can't silently drop them
  // again — the prior failure mode was invisible at type-check time
  // because the renderer-side payload was typed `unknown[]`.

  const ipcPath = path.resolve(
    import.meta.dirname,
    "..",
    "src",
    "main",
    "runtimeJobsIpc.ts"
  );

  // Since 5e05ebe51 SourceItem is `BadgerIngestSubmitSourceItemInput`, typed from the runtime contract, so the
  // fields are pinned on the contract's schema rather than on a hand-written typedef.
  it("SourceItem is the runtime contract's source item, which declares audioOverrides + subtitleOverrides", () => {
    const src = readFileSync(ipcPath, "utf8");
    expect(src).toMatch(/type SourceItem = BadgerIngestSubmitSourceItemInput;/);
    const shape = Object.keys(badgerIngestSubmitSourceItemSchema.shape);
    expect(shape, "the contract's source item must declare audioOverrides").toContain("audioOverrides");
    expect(shape, "the contract's source item must declare subtitleOverrides").toContain("subtitleOverrides");
  });

  it("submit-sources handler passes audioOverrides + subtitleOverrides into sendCommand", () => {
    const src = readFileSync(ipcPath, "utf8");
    const handlerStart = src.indexOf('"sf-runtime-jobs-submit-sources"');
    expect(handlerStart, "submit-sources handler must exist").toBeGreaterThan(
      -1,
    );
    // Slice to end-of-file or the next ipcMain.handle( — whichever comes
    // first — to capture the full handler body without depending on a
    // specific indentation/closing pattern.
    const nextHandler = src.indexOf("ipcMain.handle(", handlerStart + 1);
    const handlerBody =
      nextHandler > -1 ? src.slice(handlerStart, nextHandler) : src.slice(handlerStart);
    expect(
      handlerBody.includes("audioOverrides"),
      "submit-sources handler must forward audioOverrides to the runtime command — Bug #4 root cause was the field being dropped here",
    ).toBe(true);
    expect(
      handlerBody.includes("subtitleOverrides"),
      "submit-sources handler must forward subtitleOverrides to the runtime command",
    ).toBe(true);
  });
});
