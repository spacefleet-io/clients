// @bugfix @regression-proof
//
// Repro for "BADGER_AUTH_NOT_READY: no backend token for userId=… at extract
// time": runtime-eng's deps-adapter at apps/runtime/src/modules/index.ts
// resolves the ingest token via badgerModule.getActiveIngestToken(), which
// reads from the active IngestUserState's `config.token`. The desktop never
// forwarded the bearer token to the runtime's badger module — symptoms:
// every submitSources flow created a job that failed at the Extracting step
// ~150ms in.
//
// Fix: a new IPC `sf-badger-runtime-attach-auth` invokes the existing
// `badger.ingest.open` command with `{ userId, config: { token } }`, which
// merges the token into the IngestUserState and sets it as active. The
// renderer's auth.tsx fires this on every (token, user.id) change.
//
// These tests pin the wiring — handler exists in main, the renderer calls
// it on the auth-token effect.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..", "src");
console.info(`[badger-runtime-attach-auth:setup] desktopRoot=${desktopRoot}`);

const read = (rel: string) => {
  const abs = path.resolve(desktopRoot, rel);
  const src = readFileSync(abs, "utf8");
  console.info(`[badger-runtime-attach-auth:read] ${rel} loaded, length=${src.length} chars`);
  return src;
};

// On assertion failure, dump the relevant source slice + the matched/unmatched
// signals so a wiring regression is diagnosable from CI logs.
const dumpAttachAuthSnapshot = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [badger-runtime-attach-auth:${label}] snapshot ===`);
    for (const [k, v] of Object.entries(ctx)) {
      const str = typeof v === "string" ? v : JSON.stringify(v, null, 2);
      const trimmed = str.length > 1500 ? `${str.slice(0, 1500)}…(truncated ${str.length} chars)` : str;
      console.error(`${k}: ${trimmed}`);
    }
    console.error(`=== [badger-runtime-attach-auth:${label}] end ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("[@bugfix][@regression-proof] badger runtime attach-auth IPC wiring", () => {
  it("main runtimeJobsIpc registers sf-badger-runtime-attach-auth and sends badger.ingest.open", () => {
    console.info("[badger-runtime-attach-auth:main-ipc] checking main/runtimeJobsIpc.ts handler registration + body");
    const src = read("main/runtimeJobsIpc.ts");
    const registered =
      src.includes('ipcMain.handle(\n    "sf-badger-runtime-attach-auth"') ||
      src.includes('ipcMain.handle("sf-badger-runtime-attach-auth"');
    if (!registered) {
      dumpAttachAuthSnapshot("main-ipc-not-registered", {
        note: "ipcMain.handle for sf-badger-runtime-attach-auth not found",
        attachAuthOccurrences: (src.match(/sf-badger-runtime-attach-auth/g) ?? []).length,
      });
    }
    expect(registered, "main IPC handler must register sf-badger-runtime-attach-auth").toBe(true);

    const handlerStart = src.indexOf("sf-badger-runtime-attach-auth");
    const handlerEnd = src.indexOf("ipcMain.handle", handlerStart + 1);
    const body = src.slice(handlerStart, handlerEnd === -1 ? src.length : handlerEnd);

    const bodyChecks = {
      badgerIngestOpen: body.includes("badgerIngestOpen"),
      configToken:
        body.includes("config: { token: payload.token }") ||
        body.includes("config:{token:payload.token}"),
      seedBackendToken:
        body.includes("setRuntimeJobsBackendToken(payload.token)") ||
        body.includes("setRuntimeJobsBackendToken("),
    };
    console.info(`[badger-runtime-attach-auth:main-ipc] handler body checks=${JSON.stringify(bodyChecks)} bodyLength=${body.length}`);
    if (!bodyChecks.badgerIngestOpen || !bodyChecks.configToken || !bodyChecks.seedBackendToken) {
      dumpAttachAuthSnapshot("main-ipc-body-incomplete", { bodyChecks, body });
    }

    expect(
      bodyChecks.badgerIngestOpen,
      "handler must call sendCommand(badgerIngestOpen, …) to set state.config.token"
    ).toBe(true);
    expect(
      bodyChecks.configToken,
      "handler must pass { config: { token: payload.token } } so runtime merges it into IngestUserState"
    ).toBe(true);
    expect(
      bodyChecks.seedBackendToken,
      "handler must seed the local runtime-client session token before sendCommand"
    ).toBe(true);
  });

  it("preload exposes runtimeJobs.attachAuth bridge to the sf-badger-runtime-attach-auth IPC", () => {
    console.info("[badger-runtime-attach-auth:preload] checking preload/index.ts exposes attachAuth bridge");
    const src = read("preload/index.ts");
    const exposed = src.includes("attachAuth") && src.includes("sf-badger-runtime-attach-auth");
    console.info(`[badger-runtime-attach-auth:preload] hasAttachAuth=${src.includes("attachAuth")} hasIpcName=${src.includes("sf-badger-runtime-attach-auth")}`);
    if (!exposed) {
      dumpAttachAuthSnapshot("preload-bridge-missing", {
        hasAttachAuth: src.includes("attachAuth"),
        hasIpcName: src.includes("sf-badger-runtime-attach-auth"),
      });
    }
    expect(
      exposed,
      "preload must expose runtimeJobs.attachAuth → sf-badger-runtime-attach-auth"
    ).toBe(true);
  });

  it("auth.tsx forwards the token+userId to runtimeJobs.attachAuth on every change", () => {
    console.info("[badger-runtime-attach-auth:auth-effect] checking renderer/src/auth.tsx calls attachAuth + deps include token + user.id");
    const src = read("renderer/src/auth.tsx");
    const callsAttachAuth =
      src.includes("runtimeJobs?.attachAuth") || src.includes("runtimeJobs.attachAuth");
    if (!callsAttachAuth) {
      dumpAttachAuthSnapshot("auth-effect-no-attach-call", {
        note: "auth.tsx does not call window.sf.runtimeJobs.attachAuth",
      });
    }
    expect(
      callsAttachAuth,
      "auth.tsx must call window.sf.runtimeJobs.attachAuth"
    ).toBe(true);
    // Effect deps must include token AND user.id so the runtime side resyncs
    // on login, refresh, or user switch.
    const effectIdx = src.indexOf("runtimeJobs?.attachAuth");
    const slice = effectIdx >= 0 ? src.slice(effectIdx, effectIdx + 600) : "";
    const depChecks = {
      userId: slice.includes("user?.id") || slice.includes("user.id"),
      token: slice.includes("token"),
    };
    console.info(`[badger-runtime-attach-auth:auth-effect] effectIdx=${effectIdx} depChecks=${JSON.stringify(depChecks)}`);
    if (!depChecks.userId || !depChecks.token) {
      dumpAttachAuthSnapshot("auth-effect-deps-incomplete", { depChecks, slice });
    }
    expect(
      depChecks.userId,
      "the auth effect must depend on user.id so a re-login re-attaches"
    ).toBe(true);
    expect(
      depChecks.token,
      "the auth effect must depend on token so a refresh re-attaches"
    ).toBe(true);
  });
});
