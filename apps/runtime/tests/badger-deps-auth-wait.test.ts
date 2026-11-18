/**
 * @bugfix @regression-proof retranscode-auth-restart (issue #25, ultimate
 * stress: background=transcoding-this × disruption=runtime-kill).
 *
 * Symptom: after the runtime is SIGKILLed and respawned by the guardian, the
 * persisted format/480p retranscode job is re-queued and resumed at boot —
 * BEFORE the desktop has re-attached the user session (backend token +
 * library DB). The step deps resolved the token once, found none, and the
 * job failed TERMINALLY:
 *   - `STEP_RETRANSCODE_AUTH_NOT_READY` (retranscode step)
 *   - `AUTH_REQUIRED` (upload step: empty token reaches uploadProducedMedia)
 *   - `STEP_RETRANSCODE_SOURCE_FORMAT_NOT_FOUND` (library DB not re-opened yet;
 *     listMediaFormats rejected and the rejection was swallowed)
 *
 * Fix: step deps wait (bounded, logged, abort-aware) for auth / library DB
 * readiness and only then fail with the original error code.
 *
 * Time is driven with fake timers: the wait helper polls on setTimeout, so
 * `advanceTimersByTimeAsync` is the deterministic "time passes" signal.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBadgerStepDeps,
  type ProduceMediaOutputsFn,
  type UploadProducedMediaFn,
} from "../src/modules/badger/steps/deps-adapter";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";

const SUITE = "badger-deps-auth-wait";

const ROWS = [
  {
    id: "fmt-src",
    fileId: "f-1",
    quality: "1080p",
    initKey: "init.k",
    chunks: [{ key: "c1" }, { key: "c2" }],
  },
];

const EMPTY_PRODUCED = { videoFormats: [], audioTracks: [], subtitleTracks: [] };

const retranscodeInput = (jobId: string, signal: AbortSignal = new AbortController().signal) => ({
  userId: "user-1",
  jobId,
  mediaId: "m-1",
  fileId: "f-1",
  targetVariant: "480p",
  sourceFormatId: "fmt-src",
  sourceVariant: "1080p",
  signal,
});

const uploadInput = (jobId: string) => ({
  userId: "user-1",
  jobId,
  placementId: "placement-auth-wait",
  token: "",
  scope: "format" as const,
  variant: "480p",
  signal: new AbortController().signal,
});

describe(`[${SUITE}] resumed jobs wait for auth readiness`, () => {
  let stagingRoot = "";

  beforeEach(() => {
    vi.useFakeTimers();
    stagingRoot = mkdtempSync(join(tmpdir(), "sf-auth-wait-"));
    process.env.SF_TRANSCODE_DIR = stagingRoot;
    console.info(`[${SUITE}:beforeEach] stagingRoot=${stagingRoot}`);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.SF_TRANSCODE_DIR;
    rmSync(stagingRoot, { recursive: true, force: true });
  });

  const buildDeps = (overrides: {
    resolveToken: () => string | null;
    isOpen?: () => boolean;
    authWaitMs: number;
    authPollMs: number;
    uploadProducedMedia?: Mock;
    resolveLibraryKey?: () => string | null;
  }) => {
    const libraryDb = {
      isOpen: overrides.isOpen ?? (() => true),
      call: vi.fn(async (method: string) => {
        if (method === "listMediaFormats") return ROWS;
        throw new Error(`unexpected libraryDb.call: ${method}`);
      }),
    } as unknown as BadgerLibraryDbService;
    const produceMediaOutputs = vi.fn(async (input: { jobId: string; userId: string; inputStream?: AsyncIterable<Uint8Array> }) => {
      if (input.inputStream) {
        for await (const chunk of input.inputStream) void chunk;
      }
      return {
        jobDir: join(stagingRoot, input.userId, input.jobId),
        stateStore: {
          getState: () => ({ outputs: [{ id: "video-480p-h264", kind: "video", segments: [{}, {}] }] }),
        },
        encoder: "cpu",
        produced: EMPTY_PRODUCED,
      };
    });
    const downloadAndDecryptObject = vi.fn(async (token: string, key: string) => Buffer.from(`${token}:${key}`));
    const uploadProducedMedia =
      overrides.uploadProducedMedia ?? vi.fn(async () => ({ produced: EMPTY_PRODUCED, uploadedKeys: [] }));
    const deps = buildBadgerStepDeps({
      libraryDb,
      produceMediaOutputs: produceMediaOutputs as unknown as ProduceMediaOutputsFn,
      uploadProducedMedia: uploadProducedMedia as unknown as UploadProducedMediaFn,
      downloadAndDecryptObject,
      resolveToken: overrides.resolveToken,
      resolveLibraryKey: overrides.resolveLibraryKey ?? (() => "a".repeat(44)),
      authWaitMs: overrides.authWaitMs,
      authPollMs: overrides.authPollMs,
    });
    return { deps, libraryDb, downloadAndDecryptObject, uploadProducedMedia };
  };

  it("retranscode: token attached shortly AFTER the step starts → job succeeds with the late token", async () => {
    const label = "retranscode-late-token";
    let token: string | null = null;
    const { deps, downloadAndDecryptObject } = buildDeps({
      resolveToken: () => token,
      authWaitMs: 5_000,
      authPollMs: 10,
    });

    console.info(`[${SUITE}:${label}] invoking retranscodeFormat with NO token yet (runtime just respawned)`);
    const pending = deps.retranscodeFormat!(retranscodeInput("job-late-token"));
    // Surface a pre-fix terminal rejection as a test failure, not an unhandled rejection.
    const settled = pending.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    await vi.advanceTimersByTimeAsync(150);
    token = "tok-after-relogin";
    console.info(`[${SUITE}:${label}] token attached at +150ms`);
    await vi.advanceTimersByTimeAsync(50);

    const outcome = await settled;
    console.info(`[${SUITE}:${label}] outcome=${JSON.stringify(outcome, (_k, v) => (v instanceof Error ? v.message : v))}`);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.variant).toBe("480p");
    // Every source piece must have been downloaded with the LATE token.
    const tokens = downloadAndDecryptObject.mock.calls.map((call) => call[0]);
    expect(tokens.length).toBeGreaterThan(0);
    expect(new Set(tokens)).toEqual(new Set(["tok-after-relogin"]));
  });

  it("retranscode: library DB re-opened shortly AFTER the step starts → job succeeds (no SOURCE_FORMAT_NOT_FOUND)", async () => {
    const label = "retranscode-late-library-db";
    let open = false;
    const { deps, libraryDb } = buildDeps({
      resolveToken: () => "tok-1",
      isOpen: () => open,
      authWaitMs: 5_000,
      authPollMs: 10,
    });
    // Mirror the real service: calls reject until the db is re-opened.
    (libraryDb.call as unknown as Mock).mockImplementation(async (method: string) => {
      if (!open) throw new Error("LIBRARY_DB_NOT_OPEN");
      if (method === "listMediaFormats") return ROWS;
      throw new Error(`unexpected libraryDb.call: ${method}`);
    });

    const settled = deps.retranscodeFormat!(retranscodeInput("job-late-db")).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    await vi.advanceTimersByTimeAsync(120);
    open = true;
    console.info(`[${SUITE}:${label}] library db re-opened at +120ms`);
    await vi.advanceTimersByTimeAsync(50);

    const outcome = await settled;
    console.info(`[${SUITE}:${label}] outcome ok=${outcome.ok}`);
    expect(outcome.ok).toBe(true);
  });

  it("retranscode: token never arrives → bounded wait, then STEP_RETRANSCODE_AUTH_NOT_READY", async () => {
    const label = "retranscode-token-never";
    const { deps } = buildDeps({ resolveToken: () => null, authWaitMs: 200, authPollMs: 10 });
    const startedAt = Date.now();
    const assertion = expect(deps.retranscodeFormat!(retranscodeInput("job-never"))).rejects.toThrow(
      "STEP_RETRANSCODE_AUTH_NOT_READY"
    );
    await vi.advanceTimersByTimeAsync(400);
    await assertion;
    console.info(`[${SUITE}:${label}] rejected; fake clock advanced ${Date.now() - startedAt}ms`);
  });

  it("retranscode: the wait is bounded — still pending just before authWaitMs, rejected right after", async () => {
    const { deps } = buildDeps({ resolveToken: () => null, authWaitMs: 1_000, authPollMs: 50 });
    let rejected = false;
    const pending = deps.retranscodeFormat!(retranscodeInput("job-bounded")).catch((error: unknown) => {
      rejected = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    const error = await pending;
    expect(rejected).toBe(true);
    expect((error as Error).message).toContain("STEP_RETRANSCODE_AUTH_NOT_READY");
  });

  it("retranscode: abort while waiting for auth → CANCELLED promptly", async () => {
    const ctrl = new AbortController();
    const { deps } = buildDeps({ resolveToken: () => null, authWaitMs: 60_000, authPollMs: 10 });
    const assertion = expect(deps.retranscodeFormat!(retranscodeInput("job-abort", ctrl.signal))).rejects.toThrow(
      "CANCELLED"
    );
    await vi.advanceTimersByTimeAsync(80);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });

  it("upload: token attached shortly AFTER the step starts → uploads with the late token (no AUTH_REQUIRED)", async () => {
    const label = "upload-late-token";
    let token: string | null = null;
    const uploadProducedMedia = vi.fn(async (args: { token: string }) => {
      if (!args.token) throw new Error("AUTH_REQUIRED");
      return { produced: EMPTY_PRODUCED, uploadedKeys: ["k1"] };
    });
    const { deps } = buildDeps({
      resolveToken: () => token,
      authWaitMs: 5_000,
      authPollMs: 10,
      uploadProducedMedia,
    });
    console.info(`[${SUITE}:${label}] invoking uploadOutputs with NO token yet`);
    const settled = deps.uploadOutputs(uploadInput("job-upload")).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    await vi.advanceTimersByTimeAsync(100);
    token = "tok-after-relogin";
    await vi.advanceTimersByTimeAsync(50);

    const outcome = await settled;
    console.info(`[${SUITE}:${label}] outcome=${JSON.stringify(outcome, (_k, v) => (v instanceof Error ? v.message : v))}`);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.uploadedKeys).toEqual(["k1"]);
    expect(uploadProducedMedia.mock.calls[0][0].token).toBe("tok-after-relogin");
  });

  it("upload: a token already present resolves immediately, no timer needed", async () => {
    const { deps } = buildDeps({ resolveToken: () => "tok-now", authWaitMs: 5_000, authPollMs: 1_000 });
    // No timer advance: any wait here would hang the test.
    const result = await deps.uploadOutputs(uploadInput("job-upload-fast"));
    expect(result.uploadedKeys).toEqual([]);
  });

  // @bugfix @regression-proof (issue #25, Opus review of #48): the upload step
  // read the library key BEFORE the token wait. After a runtime respawn the
  // only key present at that moment is the startup replay's last persisted
  // entry (possibly another user's), or none at all. The desktop's
  // auth-attach sets token AND key together, so the key must be read after
  // the session wait.
  it("upload: resumed after respawn → encrypts with the key attached WITH the session, not the stale replay key", async () => {
    const label = "upload-stale-replay-key";
    let token: string | null = null;
    let key: string | null = "STALE-REPLAY-KEY-OTHER-USER";
    const uploadProducedMedia = vi.fn(async (args: { token: string; libraryKeyBase64: string | null }) => {
      console.info(`[${SUITE}:${label}] uploadProducedMedia token=${args.token} key=${args.libraryKeyBase64}`);
      return { produced: EMPTY_PRODUCED, uploadedKeys: ["k1"] };
    });
    const { deps } = buildDeps({
      resolveToken: () => token,
      resolveLibraryKey: () => key,
      authWaitMs: 5_000,
      authPollMs: 10,
      uploadProducedMedia,
    });
    console.info(`[${SUITE}:${label}] invoking uploadOutputs with replay key only, no token`);
    const settled = deps.uploadOutputs(uploadInput("job-upload-stale-key"));
    await vi.advanceTimersByTimeAsync(100);
    console.info(`[${SUITE}:${label}] desktop re-attaches session: token + real user key`);
    token = "tok-after-relogin";
    key = "REAL-USER-1-KEY";
    await vi.advanceTimersByTimeAsync(50);
    await settled;
    const args = uploadProducedMedia.mock.calls[0]?.[0];
    console.info(`[${SUITE}:${label}] calls=${uploadProducedMedia.mock.calls.length} args=${JSON.stringify(args)}`);
    expect(args.token).toBe("tok-after-relogin");
    expect(args.libraryKeyBase64).toBe("REAL-USER-1-KEY");
  });

  it("upload: resumed with an empty key store → waits for the key instead of uploading with null (media_key_missing)", async () => {
    const label = "upload-empty-key-store";
    let token: string | null = null;
    let key: string | null = null;
    const uploadProducedMedia = vi.fn(async (args: { token: string; libraryKeyBase64: string | null }) => {
      console.info(`[${SUITE}:${label}] uploadProducedMedia token=${args.token} key=${args.libraryKeyBase64}`);
      if (!args.libraryKeyBase64) throw new Error("media_key_missing");
      return { produced: EMPTY_PRODUCED, uploadedKeys: ["k1"] };
    });
    const { deps } = buildDeps({
      resolveToken: () => token,
      resolveLibraryKey: () => key,
      authWaitMs: 5_000,
      authPollMs: 10,
      uploadProducedMedia,
    });
    const settled = deps.uploadOutputs(uploadInput("job-upload-no-key")).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    await vi.advanceTimersByTimeAsync(100);
    console.info(`[${SUITE}:${label}] token attaches first, key lands one poll later`);
    token = "tok-after-relogin";
    await vi.advanceTimersByTimeAsync(15);
    key = "REAL-USER-1-KEY";
    await vi.advanceTimersByTimeAsync(50);
    const outcome = await settled;
    console.info(`[${SUITE}:${label}] outcome=${JSON.stringify(outcome, (_k, v) => (v instanceof Error ? v.message : v))}`);
    expect(outcome.ok).toBe(true);
    expect(uploadProducedMedia.mock.calls[0][0].libraryKeyBase64).toBe("REAL-USER-1-KEY");
  });
});
