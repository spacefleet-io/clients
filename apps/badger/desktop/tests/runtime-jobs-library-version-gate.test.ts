/**
 * Phase 3 Part B — cross-stream version correlation.
 *
 * Closes the residual race between the runtime jobs SSE
 * (`runtime.jobs.succeeded`) and the library SSE (`library.updated`). The
 * succeeded event optionally carries `libraryVersionAtDone`; the renderer
 * persists it on the per-job record and the play-button gate stays closed
 * until the renderer's last-seen library snapshot version >= that stamp.
 *
 * Plan reference: we-ve-done-quite-a-immutable-dahl.md (Phase 3).
 *
 * Coverage in this file:
 *   - Reducer stores `libraryVersionAtDone` from succeeded event payload.
 *   - Reducer leaves it `undefined` when the event omits it (back-compat).
 *   - `isLibraryVersionPending` gate helper:
 *       * hasFiles=true + version=stamp + currentVersion=stamp → not pending.
 *       * hasFiles=true + currentVersion < stamp → pending (race window).
 *       * hasFiles=true + libraryVersionAtDone undefined → not pending.
 *       * hasFiles=false → caller's pre-existing hasFiles gate handles it
 *         (helper is independent of hasFiles by design).
 */

import { describe, expect, it } from "vitest";
import {
  applyIngestJobEvent,
  isLibraryVersionPending,
  LIBRARY_VERSION_GATE_TIMEOUT_MS,
  type IngestJobRecord,
} from "../src/renderer/src/lib/runtimeIngestJobs";
import type { RuntimeJobsEvent } from "@space/runtime-contracts/runtime/jobs";

const baseRecord = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId: "job-1",
  app: "badger",
  kind: "source",
  lane: "source",
  status: "succeeded",
  stageCode: "done",
  stageLabel: "Done",
  progress: { mode: "none", completed: null, total: null, unit: null },
  payload: { filename: "movie.mkv" },
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: true,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: "2026-04-01T00:00:00Z",
  updatedAt: "2026-04-01T00:00:01Z",
  startedAt: "2026-04-01T00:00:00Z",
  finishedAt: "2026-04-01T00:00:01Z",
  groupId: "media-1",
  mediaId: "media-1",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  progressPct: 100,
  ...overrides,
});

const succeededEvent = (
  overrides: Partial<RuntimeJobsEvent & { libraryVersionAtDone?: number }> = {},
  recordOverrides: Partial<IngestJobRecord> = {},
): RuntimeJobsEvent =>
  ({
    eventId: 42,
    emittedAt: "2026-04-01T00:00:01Z",
    event: "runtime.jobs.succeeded",
    job: baseRecord(recordOverrides),
    ...overrides,
  }) as RuntimeJobsEvent;

// On assertion failure, dump the resolved job record + the gate-relevant
// fields so a regression is diagnosable without re-running under a debugger.
// Body is wrapped so a dump failure can never mask the real assertion failure.
const dumpVersionGateSnapshot = (
  label: string,
  ctx: {
    record?: IngestJobRecord | undefined;
    event?: RuntimeJobsEvent | undefined;
    gateInput?: unknown;
    currentVersion?: number | undefined;
    now?: number | undefined;
    pending?: boolean | undefined;
  },
) => {
  try {
    console.error(`=== [runtime-jobs-library-version-gate:${label}] snapshot ===`);
    console.error(`LIBRARY_VERSION_GATE_TIMEOUT_MS=${LIBRARY_VERSION_GATE_TIMEOUT_MS}`);
    if (ctx.record !== undefined) {
      console.error(
        `job record: status=${ctx.record?.status} libraryVersionAtDone=${JSON.stringify(
          ctx.record?.libraryVersionAtDone,
        )} libraryVersionDoneAt=${JSON.stringify(ctx.record?.libraryVersionDoneAt)}`,
      );
      console.error(`job record (full):\n${JSON.stringify(ctx.record, null, 2)}`);
    }
    if (ctx.event !== undefined) {
      console.error(`source event:\n${JSON.stringify(ctx.event, null, 2)}`);
    }
    if (ctx.gateInput !== undefined) {
      console.error(`gate input record:\n${JSON.stringify(ctx.gateInput)}`);
    }
    if (ctx.currentVersion !== undefined) {
      console.error(`currentLibraryVersion=${JSON.stringify(ctx.currentVersion)}`);
    }
    if (ctx.now !== undefined) {
      console.error(`now=${JSON.stringify(ctx.now)}`);
    }
    if (ctx.pending !== undefined) {
      console.error(`isLibraryVersionPending => ${JSON.stringify(ctx.pending)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("applyIngestJobEvent runtime.jobs.succeeded @bugfix @regression-proof", () => {
  it("stores libraryVersionAtDone from the succeeded event onto the job record", () => {
    console.info(
      `[runtime-jobs-library-version-gate:store] applying succeeded event with libraryVersionAtDone=1923`,
    );
    const byId = new Map<string, IngestJobRecord>();
    const event = succeededEvent({ libraryVersionAtDone: 1923 });
    const next = applyIngestJobEvent(byId, event);
    const rec = next.get("job-1");
    if (!rec || rec.libraryVersionAtDone !== 1923 || rec.status !== "succeeded") {
      dumpVersionGateSnapshot("store", { record: rec, event });
    }
    expect(rec).toBeDefined();
    expect(rec?.libraryVersionAtDone).toBe(1923);
    expect(rec?.status).toBe("succeeded");
  });

  it("leaves libraryVersionAtDone undefined when the event omits it (back-compat)", () => {
    console.info(
      `[runtime-jobs-library-version-gate:store-backcompat] applying succeeded event with NO libraryVersionAtDone`,
    );
    const byId = new Map<string, IngestJobRecord>();
    const event = succeededEvent();
    const next = applyIngestJobEvent(byId, event);
    const rec = next.get("job-1");
    if (!rec || rec.libraryVersionAtDone !== undefined) {
      dumpVersionGateSnapshot("store-backcompat", { record: rec, event });
    }
    expect(rec).toBeDefined();
    expect(rec?.libraryVersionAtDone).toBeUndefined();
  });

  it("preserves libraryVersionAtDone=0 (a valid non-negative version)", () => {
    // Edge case: an explicit zero must NOT be treated as undefined. The
    // `null vs undefined` distinction matters because the gate's null-check
    // is `== null`, which permits 0 to fall through correctly.
    console.info(
      `[runtime-jobs-library-version-gate:store-zero] applying succeeded event with libraryVersionAtDone=0`,
    );
    const byId = new Map<string, IngestJobRecord>();
    const event = succeededEvent({ libraryVersionAtDone: 0 });
    const next = applyIngestJobEvent(byId, event);
    const rec = next.get("job-1");
    if (rec?.libraryVersionAtDone !== 0) {
      dumpVersionGateSnapshot("store-zero", { record: rec, event });
    }
    expect(rec?.libraryVersionAtDone).toBe(0);
  });
});

describe("isLibraryVersionPending @bugfix @regression-proof", () => {
  it("play-button gate: stamp=1923, currentVersion=1923 → NOT pending (gate stays open)", () => {
    const gateInput = { libraryVersionAtDone: 1923 };
    const pending = isLibraryVersionPending(gateInput, 1923);
    console.info(`[runtime-jobs-library-version-gate:gate-equal] pending=${pending}`);
    if (pending !== false) {
      dumpVersionGateSnapshot("gate-equal", { gateInput, currentVersion: 1923, pending });
    }
    expect(pending).toBe(false);
  });

  it("play-button gate: stamp=1923, currentVersion=1924 → NOT pending (renderer ahead)", () => {
    const gateInput = { libraryVersionAtDone: 1923 };
    const pending = isLibraryVersionPending(gateInput, 1924);
    console.info(`[runtime-jobs-library-version-gate:gate-ahead] pending=${pending}`);
    if (pending !== false) {
      dumpVersionGateSnapshot("gate-ahead", { gateInput, currentVersion: 1924, pending });
    }
    expect(pending).toBe(false);
  });

  it("play-button gate: stamp=1923, currentVersion=1900, fresh doneAt → PENDING (race window)", () => {
    // The race the fix targets: jobs SSE delivered `succeeded` with
    // libraryVersionAtDone=1923, but the library SSE has only delivered
    // up to v1900 so far. The succeeded event landed `now`, well inside
    // the stabilization window, so the gate must hold the user back.
    const now = 1_000_000;
    const gateInput = { libraryVersionAtDone: 1923, libraryVersionDoneAt: now };
    const pending = isLibraryVersionPending(gateInput, 1900, now);
    console.info(
      `[runtime-jobs-library-version-gate:gate-race] currentVersion=1900 stamp=1923 now=${now} pending=${pending}`,
    );
    if (pending !== true) {
      dumpVersionGateSnapshot("gate-race", { gateInput, currentVersion: 1900, now, pending });
    }
    expect(pending).toBe(true);
  });

  it("play-button gate: libraryVersionAtDone undefined → NOT pending (back-compat fallthrough)", () => {
    // Pre-Phase-3 events replayed from the SSE log won't carry the field;
    // older runtime versions don't emit it. In both cases the pre-existing
    // hasFiles check is the only gate.
    const gateInput = { libraryVersionAtDone: undefined };
    const pending = isLibraryVersionPending(gateInput, 1923);
    console.info(`[runtime-jobs-library-version-gate:gate-no-stamp] pending=${pending}`);
    if (pending !== false) {
      dumpVersionGateSnapshot("gate-no-stamp", { gateInput, currentVersion: 1923, pending });
    }
    expect(pending).toBe(false);
  });

  it("play-button gate: currentLibraryVersion undefined → NOT pending (no snapshot yet)", () => {
    // Before the first remote snapshot has been applied the gate cannot
    // make a meaningful comparison. Falling back to "open" preserves
    // existing behavior for cold-start; the hasFiles check remains.
    const gateInput = { libraryVersionAtDone: 1923 };
    const pending = isLibraryVersionPending(gateInput, undefined);
    console.info(`[runtime-jobs-library-version-gate:gate-no-snapshot] pending=${pending}`);
    if (pending !== false) {
      dumpVersionGateSnapshot("gate-no-snapshot", { gateInput, currentVersion: undefined, pending });
    }
    expect(pending).toBe(false);
  });

  it("play-button gate: missing job (no in-flight ingest for media) → NOT pending", () => {
    // When a media item has no associated runtime ingest job at all, the
    // gate must not interfere. Library.tsx and MediaDetailsDialog.tsx call
    // the helper on the optional per-media record; null/undefined inputs
    // must short-circuit to false.
    const pendingNull = isLibraryVersionPending(null, 1923);
    const pendingUndef = isLibraryVersionPending(undefined, 1923);
    console.info(
      `[runtime-jobs-library-version-gate:gate-missing-job] pending(null)=${pendingNull} pending(undefined)=${pendingUndef}`,
    );
    if (pendingNull !== false || pendingUndef !== false) {
      dumpVersionGateSnapshot("gate-missing-job", {
        currentVersion: 1923,
        pending: pendingNull || pendingUndef,
      });
    }
    expect(pendingNull).toBe(false);
    expect(pendingUndef).toBe(false);
  });

  it("play-button gate: gate is OPEN after stabilization timeout even if currentVersion stale", () => {
    // Network blip / runtime hot-reload / dev-mode warmup can leave the
    // library SSE behind. Without a timeout, the user is locked out
    // forever. With the timeout: once `now - doneAt > 2000ms`, the gate
    // falls open and the existing hasFiles check is the only safety net.
    const doneAt = 1_000_000;
    const now = doneAt + LIBRARY_VERSION_GATE_TIMEOUT_MS + 1;
    const gateInput = { libraryVersionAtDone: 1923, libraryVersionDoneAt: doneAt };
    const pending = isLibraryVersionPending(gateInput, 1900, now);
    console.info(
      `[runtime-jobs-library-version-gate:gate-timeout-open] elapsed=${now - doneAt}ms (timeout=${LIBRARY_VERSION_GATE_TIMEOUT_MS}) currentVersion=1900 stale pending=${pending}`,
    );
    if (pending !== false) {
      dumpVersionGateSnapshot("gate-timeout-open", { gateInput, currentVersion: 1900, now, pending });
    }
    expect(pending).toBe(false);
  });

  it("play-button gate: gate stays CLOSED if version catches up before timeout", () => {
    // Production-typical case (ui-driver Run 7 measured 699ms): the
    // library SSE arrives well inside the 2s window, version catches up,
    // gate falls open via the existing version-equal short-circuit (NOT
    // the timeout fallback). Same-time scenario locks in the existing
    // behavior for the common path.
    const doneAt = 1_000_000;
    const within = doneAt + 700; // 700ms after done — within window
    const gateInput = { libraryVersionAtDone: 1923, libraryVersionDoneAt: doneAt };
    const pending = isLibraryVersionPending(gateInput, 1923, within);
    console.info(
      `[runtime-jobs-library-version-gate:gate-caught-up] elapsed=${within - doneAt}ms currentVersion=1923 caught-up pending=${pending}`,
    );
    if (pending !== false) {
      dumpVersionGateSnapshot("gate-caught-up", { gateInput, currentVersion: 1923, now: within, pending });
    }
    expect(pending).toBe(false);
  });
});

describe("applyIngestJobEvent stamps libraryVersionDoneAt @bugfix @regression-proof", () => {
  it("stamps libraryVersionDoneAt = Date.now() when the succeeded event carries libraryVersionAtDone", () => {
    const before = Date.now();
    const byId = new Map<string, IngestJobRecord>();
    const event = succeededEvent({ libraryVersionAtDone: 1923 });
    const next = applyIngestJobEvent(byId, event);
    const after = Date.now();
    const rec = next.get("job-1");
    console.info(
      `[runtime-jobs-library-version-gate:stamp] before=${before} doneAt=${rec?.libraryVersionDoneAt} after=${after}`,
    );
    const inWindow =
      typeof rec?.libraryVersionDoneAt === "number" &&
      rec.libraryVersionDoneAt >= before &&
      rec.libraryVersionDoneAt <= after;
    if (!rec || !inWindow) {
      dumpVersionGateSnapshot("stamp", { record: rec, event });
      console.error(
        `[runtime-jobs-library-version-gate:stamp] expected doneAt in [${before}, ${after}], observed=${rec?.libraryVersionDoneAt}`,
      );
    }
    expect(rec).toBeDefined();
    expect(typeof rec?.libraryVersionDoneAt).toBe("number");
    // The stamp must lie in the [before, after] window — anything else
    // means we used a stale clock or someone else's timestamp.
    expect(rec!.libraryVersionDoneAt!).toBeGreaterThanOrEqual(before);
    expect(rec!.libraryVersionDoneAt!).toBeLessThanOrEqual(after);
  });

  it("leaves libraryVersionDoneAt undefined when libraryVersionAtDone is absent", () => {
    // Older runtime / replayed events without the version field should NOT
    // stamp a timestamp — the gate would never use it anyway and a stray
    // timestamp is just noise.
    const byId = new Map<string, IngestJobRecord>();
    const event = succeededEvent();
    const next = applyIngestJobEvent(byId, event);
    const rec = next.get("job-1");
    if (rec?.libraryVersionDoneAt !== undefined) {
      dumpVersionGateSnapshot("stamp-backcompat", { record: rec, event });
    }
    expect(rec?.libraryVersionDoneAt).toBeUndefined();
  });
});
