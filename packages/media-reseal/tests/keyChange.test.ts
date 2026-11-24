/**
 * @test-id MEDIA-RESEAL-KEY-CHANGE-001
 * @level unit
 * @req ACCT-KEYCHG-01
 * @req ACCT-KEYCHG-03
 * @req ACCT-KEYCHG-06
 * @req ACCT-KEYCHG-08
 * @req STOR-RESEAL-01
 * @why Chris (2026-11-23, rotate drafts review and Q1/Q2, relayed by Main): every app that can change the key runs the
 *   same key change: the password and code are checked as the run opens, every media file is copied, and the switch
 *   names the run without asking again, carrying this app's library and the other app's with their references renamed
 *   to the copies; an account without media switches at once; a switch waiting on another device's uploads waits, then
 *   "Switch now" sends `switchNow`; Stop deletes the copies and changes nothing.
 */
import { ApiError } from "@space/shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResealRunProgress } from "../src/run";

const api = vi.hoisted(() => ({
  abandonMediaResealRun: vi.fn(),
  deleteStorageObjects: vi.fn(),
  getKeyRotationReadiness: vi.fn(),
  getMediaResealRun: vi.fn(),
  openMediaResealRun: vi.fn(),
  rotateLibraryKey: vi.fn(),
}));
const run = vi.hoisted(() => ({ collectResealCopies: vi.fn(), resealIoForRun: vi.fn(), runMediaReseal: vi.fn() }));

vi.mock("@space/shared/api", async (original) => ({ ...(await original<typeof import("@space/shared/api")>()), ...api }));
vi.mock("../src/run", async (original) => ({ ...(await original<typeof import("../src/run")>()), ...run }));
vi.mock("../src/sealing", async (original) => ({
  ...(await original<typeof import("../src/sealing")>()),
  importResealKeyFromBase64: vi.fn(async (key: string) => ({ key })),
}));

const { createKeyChange } = await import("../src/keyChange");

const OWN = {
  manifestBase64: "b3du",
  snapshotId: "own-1",
  chunkSize: 4194304,
  chunkRefs: ["c0ffee01"],
  chunkRefsSource: { client: "desktop-runtime" as const, refsVersion: 1 },
  storageFormatVersion: 2,
  opStreamVersion: 3,
};
const OTHER = { ...OWN, snapshotId: "other-1", appId: "parrot" as const, baseVersion: 4 };
const COPIES = new Map([["media/a", "media/a2"]]);
const PROGRESS: ResealRunProgress = { totalFiles: 2, doneFiles: 2, keptFiles: 0, transferBytes: 20, transferredBytes: 20 };

const apiError = (status: number, payload: Record<string, unknown>) => new ApiError(status, payload);

const setup = (oldKey: string | null = "old-key") => {
  const app = {
    appId: "parrot" as const,
    oldKey: vi.fn(async () => oldKey),
    sealOwnLibrary: vi.fn(async () => OWN),
    reencryptOtherLibraries: vi.fn(async () => [OTHER]),
    keyProbe: vi.fn(async () => "probe"),
  };
  const states: string[] = [];
  const change = createKeyChange({ token: "tok", newKeyBase64: "new-key", app, onState: (s) => states.push(s.phase) });
  return { app, change, states };
};

beforeEach(() => {
  api.getKeyRotationReadiness.mockResolvedValue({ needsMediaReseal: true });
  api.openMediaResealRun.mockResolvedValue({ run: { id: "run-1" } });
  api.rotateLibraryKey.mockResolvedValue({ version: 9 });
  api.abandonMediaResealRun.mockResolvedValue({ abandoned: true, purgeQueued: 1 });
  run.resealIoForRun.mockReturnValue({});
  run.collectResealCopies.mockResolvedValue(COPIES);
  run.runMediaReseal.mockImplementation(async (_io: unknown, _keys: unknown, options: { onProgress?: (p: ResealRunProgress) => void }) => {
    options.onProgress?.(PROGRESS);
    return { copied: 2, kept: 0, stopped: false };
  });
});

afterEach(() => vi.clearAllMocks());

describe("createKeyChange", () => {
  it("switches at once with the password and code when the account has no media", async () => {
    api.getKeyRotationReadiness.mockResolvedValue({ needsMediaReseal: false });
    const { app, change } = setup();

    await expect(change.start({ password: "pw", twoFactorCode: "123456" })).resolves.toBe("switched");

    expect(api.openMediaResealRun).not.toHaveBeenCalled();
    expect(app.sealOwnLibrary).toHaveBeenCalledWith("new-key", new Map());
    expect(api.rotateLibraryKey).toHaveBeenCalledWith("tok", OWN, "probe", "pw", "123456", [OTHER], undefined, "parrot");
  });

  it("checks the password as the run opens, copies every file, then switches naming the run with nothing asked again", async () => {
    const { app, change, states } = setup();

    await expect(change.start({ password: "pw", twoFactorCode: "123456" })).resolves.toBe("switched");

    expect(api.openMediaResealRun).toHaveBeenCalledWith("tok", { password: "pw", twoFactorCode: "123456", restart: true });
    expect(run.resealIoForRun).toHaveBeenCalledWith("tok", "run-1");
    expect(run.runMediaReseal.mock.calls[0]![1]).toEqual({ from: { key: "old-key" }, to: { key: "new-key" } });
    // The references of both libraries are renamed to the run's copies (STOR-RESEAL-01).
    expect(app.sealOwnLibrary).toHaveBeenCalledWith("new-key", COPIES);
    expect(app.reencryptOtherLibraries).toHaveBeenCalledWith("old-key", "new-key", COPIES);
    // The rotation is made in the name of the app whose library is sealed.
    expect(api.rotateLibraryKey).toHaveBeenCalledWith("tok", OWN, "probe", undefined, undefined, [OTHER], { runId: "run-1" }, "parrot");
    expect(states).toEqual(["resealing", "resealing", "ready", "form"]);
    expect(change.state().phase).toBe("form");
  });

  it("passes the file gate to the copying (ACCT-KEYCHG-05)", async () => {
    const beforeFile = vi.fn(async () => undefined);
    const app = {
      appId: "badger" as const,
      oldKey: async () => "old-key",
      sealOwnLibrary: async () => OWN,
      reencryptOtherLibraries: async () => [],
      keyProbe: async () => "probe",
    };
    await createKeyChange({ token: "tok", newKeyBase64: "new-key", app, beforeFile }).start({ password: "pw" });
    expect(run.runMediaReseal.mock.calls[0]![2]).toMatchObject({ beforeFile });
  });

  it("sends no other library without the old key", async () => {
    api.getKeyRotationReadiness.mockResolvedValue({ needsMediaReseal: false });
    const { app, change } = setup(null);
    await change.start({ password: "pw" });
    expect(app.reencryptOtherLibraries).not.toHaveBeenCalled();
    expect(api.rotateLibraryKey).toHaveBeenCalledWith("tok", OWN, "probe", "pw", undefined, [], undefined, "parrot");
  });

  it("waits on another device's uploads, switches when they end, and Switch now sends switchNow", async () => {
    api.rotateLibraryKey.mockRejectedValueOnce(apiError(409, { error: "uploads_in_flight", uploadsInFlight: 2, switchNowAt: "2026-11-24T10:00:00.000Z" }));
    const { change } = setup();

    await expect(change.start({ password: "pw" })).resolves.toBe("waiting");
    expect(change.state()).toMatchObject({ phase: "waiting", uploadsInFlight: 2, switchNowAt: "2026-11-24T10:00:00.000Z" });

    api.getMediaResealRun.mockResolvedValueOnce({ uploadsInFlight: 1, switchNowAt: "2026-11-24T10:00:00.000Z" });
    await expect(change.poll()).resolves.toBeNull();
    expect(change.state().uploadsInFlight).toBe(1);

    await expect(change.switchNow()).resolves.toBe("switched");
    expect(api.rotateLibraryKey).toHaveBeenLastCalledWith("tok", OWN, "probe", undefined, undefined, [OTHER], { runId: "run-1", switchNow: true }, "parrot");
  });

  it("switches from the poll once the other uploads ended", async () => {
    api.rotateLibraryKey.mockRejectedValueOnce(apiError(409, { error: "uploads_in_flight", uploadsInFlight: 1, switchNowAt: null }));
    const { change } = setup();
    await change.start({ password: "pw" });
    api.getMediaResealRun.mockResolvedValueOnce({ uploadsInFlight: 0, switchNowAt: null });
    await expect(change.poll()).resolves.toBe("switched");
    expect(api.rotateLibraryKey).toHaveBeenLastCalledWith("tok", OWN, "probe", undefined, undefined, [OTHER], { runId: "run-1" }, "parrot");
  });

  it("keeps Finish open after a refused switch, and forgets a run the server closed", async () => {
    api.rotateLibraryKey.mockRejectedValueOnce(apiError(409, { error: "version_conflict" }));
    const { change } = setup();
    await expect(change.start({ password: "pw" })).rejects.toBeInstanceOf(ApiError);
    expect(change.state().phase).toBe("ready");

    api.rotateLibraryKey.mockRejectedValueOnce(apiError(409, { error: "reseal_run_not_open" }));
    await expect(change.resume()).rejects.toBeInstanceOf(ApiError);
    expect(change.state().phase).toBe("form");
    await expect(change.resume()).rejects.toThrow("reseal_run_missing");
  });

  it("stops: the copying pauses, the run is abandoned and nothing switches (ACCT-KEYCHG-08)", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    run.runMediaReseal.mockImplementationOnce(async (_io: unknown, _keys: unknown, options: { signal: AbortSignal }) => {
      await held;
      return { copied: 0, kept: 0, stopped: options.signal.aborted };
    });
    const { change } = setup();
    const started = change.start({ password: "pw" });
    await vi.waitFor(() => expect(change.state().phase).toBe("resealing"));

    const stopping = change.stop();
    release();
    await expect(started).resolves.toBe("stopped");
    await stopping;

    expect(api.abandonMediaResealRun).toHaveBeenCalledWith("tok", "run-1");
    expect(api.rotateLibraryKey).not.toHaveBeenCalled();
    expect(change.state().phase).toBe("form");
  });

  it("stays ready when the stop is refused", async () => {
    api.rotateLibraryKey.mockRejectedValueOnce(apiError(500, { error: "internal" }));
    const { change } = setup();
    await expect(change.start({ password: "pw" })).rejects.toBeInstanceOf(ApiError);
    api.abandonMediaResealRun.mockRejectedValueOnce(apiError(503, { error: "unavailable" }));
    await expect(change.stop()).rejects.toBeInstanceOf(ApiError);
    expect(change.state().phase).toBe("ready");
  });

  it("deletes the unreadable files 500 at a time", async () => {
    const { change } = setup();
    const files = Array.from({ length: 501 }, (_, i) => ({ key: `media/${i}`, sizeBytes: 1 }));
    await change.deleteUnreadableFiles(files);
    expect(api.deleteStorageObjects.mock.calls.map(([, keys]) => keys.length)).toEqual([500, 1]);
  });
});
