// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-KEY-CHANGE-FLOW-001
 * @level unit
 * @req ACCT-KEYCHG-03[badger-desktop]
 * @req ACCT-KEYCHG-06[badger-desktop]
 * @req ACCT-KEYCHG-08[badger-desktop]
 * @req STOR-RESEAL-01[badger-desktop]
 * @why Chris (2026-11-23, rotate drafts review, relayed by Main): before a key change touches any media, the password
 *   (and 2FA code) is checked; every media file is then re-sealed under the new key and the switch publishes the
 *   libraries with their references renamed to the copies, naming the run; a run left open without this dialog's key
 *   is stopped and opened afresh; a switch that waits on another device's uploads waits, and "Switch now" sends
 *   `switchNow`; Stop deletes the run's copies and changes nothing.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResealRunProgress } from "@space/media-reseal";
import type { useLibraryRecoveryFlows as UseFlows } from "../src/renderer/src/lib/settings/useLibraryRecoveryFlows";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  abandonMediaResealRun: vi.fn(),
  deleteStorageObjects: vi.fn(),
  getKeyRotationReadiness: vi.fn(),
  getMediaResealRun: vi.fn(),
  openMediaResealRun: vi.fn(),
  reauthSession: vi.fn(),
  resetLibrary: vi.fn(),
  rotateLibraryKey: vi.fn(),
}));
const reseal = vi.hoisted(() => ({
  collectResealCopies: vi.fn(),
  importResealKeyFromBase64: vi.fn(),
  resealIoForRun: vi.fn(),
  runMediaReseal: vi.fn(),
}));
const libraryDb = vi.hoisted(() => ({ reencryptForRotation: vi.fn() }));
const session = vi.hoisted(() => ({ logout: vi.fn(), sealLibraryForRotation: vi.fn(), clearLocalCache: vi.fn() }));
/** This library sealed under the new key (PRIV-KEY-13), as `sealLibraryForRotation` answers. */
const OWN = {
  manifestBase64: "b3du",
  snapshotId: "own-1",
  chunkSize: 4194304,
  chunkRefs: ["c0ffee01"],
  chunkRefsSource: { client: "desktop-runtime", refsVersion: 1 },
  storageFormatVersion: 2,
  opStreamVersion: 3,
};

// vi.mock factories are hoisted above the static imports, so the real ApiError is loaded inside the factory. The key
// change itself runs in `@space/media-reseal` (shared by every app) on the shared API; its run is mocked underneath.
vi.mock("../src/renderer/src/api", async () => ({
  ApiError: (await import("@space/shared/api")).ApiError,
  ...api,
}));
vi.mock("@space/shared/api", async (original) => ({ ...(await original<typeof import("@space/shared/api")>()), ...api }));
vi.mock("@space/media-reseal/run", async (original) => ({
  ...(await original<typeof import("@space/media-reseal/run")>()),
  collectResealCopies: reseal.collectResealCopies,
  resealIoForRun: reseal.resealIoForRun,
  runMediaReseal: reseal.runMediaReseal,
}));
vi.mock("@space/media-reseal/sealing", async (original) => ({
  ...(await original<typeof import("@space/media-reseal/sealing")>()),
  importResealKeyFromBase64: reseal.importResealKeyFromBase64,
}));
vi.mock("../src/renderer/src/lib/libraryDb", () => ({ LibraryDb: libraryDb }));
vi.mock("../src/renderer/src/auth", () => ({
  useAuth: () => ({ token: "tok", logout: session.logout }),
  useHasPassword: () => true,
}));
vi.mock("../src/renderer/src/lib/libraryContext", () => ({
  useLibraryActions: () => ({ sealLibraryForRotation: session.sealLibraryForRotation, clearLocalCache: session.clearLocalCache }),
}));
vi.mock("../src/renderer/src/lib/crypto", () => ({ encryptBytesToBase64: vi.fn(async () => "sealed") }));
vi.mock("../src/renderer/src/lib/onboarding", () => ({
  clearLibraryKey: vi.fn(async () => undefined),
  getStoredLibraryKey: vi.fn(async () => "old-key"),
  getStoredLibraryKeyWords: vi.fn(async () => null),
  storeLibraryKey: vi.fn(async () => undefined),
}));
vi.mock("../src/renderer/src/lib/notify", () => ({ notify: vi.fn() }));
const t = (key: string) => key;
const i18n = { language: "en" };
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t, i18n }) }));

const SUITE = "[key-change-flow]";
type Flows = ReturnType<typeof UseFlows>;

let flows: Flows | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const mount = async () => {
  const { useLibraryRecoveryFlows } = await import("../src/renderer/src/lib/settings/useLibraryRecoveryFlows");
  function Harness() {
    flows = useLibraryRecoveryFlows();
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Harness />));
};

const current = () => flows!;
const flush = () =>
  act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });

/** Opens the dialog, confirms the words were saved and types the password, as the form does. */
const fillForm = async () => {
  act(() => current().setRecoveryOpen(true));
  act(() => current().setRecoveryConfirmed(true));
  act(() => current().setRecoveryPassword("pw"));
};
const start = async () => {
  await act(async () => await current().submitRecovery());
};

const progress: ResealRunProgress = { totalFiles: 2, doneFiles: 2, keptFiles: 0, transferBytes: 20, transferredBytes: 20 };
const copies = new Map([["u/old-1", "u/new-1"]]);

beforeEach(() => {
  vi.clearAllMocks();
  api.getKeyRotationReadiness.mockResolvedValue({ needsMediaReseal: true });
  api.reauthSession.mockResolvedValue({ ok: true });
  api.openMediaResealRun.mockResolvedValue({ run: { id: "run-1" }, created: true });
  api.abandonMediaResealRun.mockResolvedValue({ abandoned: true, purgeQueued: 0 });
  api.rotateLibraryKey.mockResolvedValue({ ok: true });
  reseal.importResealKeyFromBase64.mockImplementation(async (key: string) => `imported:${key}`);
  reseal.resealIoForRun.mockImplementation((token: string, runId: string) => ({ token, runId }));
  reseal.runMediaReseal.mockImplementation(async (_io, _keys, options: { onProgress?: (p: ResealRunProgress) => void }) => {
    options.onProgress?.(progress);
    return { copied: 2, kept: 0, stopped: false };
  });
  reseal.collectResealCopies.mockResolvedValue(copies);
  libraryDb.reencryptForRotation.mockResolvedValue([{ appId: "parrot", blobBase64: "p", baseVersion: 1 }]);
  session.sealLibraryForRotation.mockResolvedValue(OWN);
  session.logout.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  flows = null;
});

describe(`${SUITE} start`, () => {
  it("opens the run with the password before any media is touched, then re-seals and switches naming the run, asked nothing again", async () => {
    await mount();
    await fillForm();
    await start();
    const order = [api.openMediaResealRun, reseal.runMediaReseal, api.rotateLibraryKey].map((fn) => fn.mock.invocationCallOrder[0] ?? -1);
    console.log(`${SUITE} order=${JSON.stringify(order)} error=${current().recoveryError}`);
    // ACCT-KEYCHG-03: the password is checked by the run's open (which abandons a run left open, in the same request).
    expect(api.openMediaResealRun).toHaveBeenCalledWith("tok", { password: "pw", twoFactorCode: undefined, restart: true });
    expect(api.reauthSession).not.toHaveBeenCalled();
    expect(api.abandonMediaResealRun).not.toHaveBeenCalled();
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((n) => n > 0)).toBe(true);
    // The run is re-sealed from the stored key to the dialog's new key.
    const newKey = current().recoveryKey?.keyBase64;
    expect(reseal.runMediaReseal.mock.calls[0]![1]).toEqual({ from: "imported:old-key", to: `imported:${newKey}` });
    // References are renamed to the copies in what is published, and in every other app's library.
    expect(session.sealLibraryForRotation).toHaveBeenCalledWith(newKey, copies);
    expect(libraryDb.reencryptForRotation).toHaveBeenCalledWith("tok", "old-key", newKey, copies);
    const rotate = api.rotateLibraryKey.mock.calls[0]!;
    // PRIV-KEY-13: this library goes as the snapshot sealed under the new key, declaring its formats.
    expect(rotate[1]).toEqual(OWN);
    // The switch names the run this session opened: no password, no code.
    expect({ password: rotate[3], code: rotate[4] }).toEqual({ password: undefined, code: undefined });
    expect(rotate[5]).toEqual([{ appId: "parrot", blobBase64: "p", baseVersion: 1 }]);
    expect(rotate[6]).toEqual({ runId: "run-1" });
    expect(session.logout).toHaveBeenCalledWith("sessionRejected");
  });

  it("touches no media when the password is wrong", async () => {
    const { ApiError } = await import("@space/shared/api");
    api.openMediaResealRun.mockRejectedValue(new ApiError(401, { error: "invalid_password" }));
    await mount();
    await fillForm();
    await start();
    expect(current().recoveryError).toBe("Incorrect password.");
    expect(reseal.runMediaReseal).not.toHaveBeenCalled();
    expect(api.rotateLibraryKey).not.toHaveBeenCalled();
    expect(current().keyChange.phase).toBe("form");
  });

  it("asks for the 2FA code before any media is touched, and never resends it", async () => {
    const { ApiError } = await import("@space/shared/api");
    api.openMediaResealRun.mockRejectedValueOnce(new ApiError(401, { error: "two_factor_required", method: "email" }));
    await mount();
    await fillForm();
    await start();
    expect(current().recoveryNeedsCode).toBe(true);
    expect(reseal.runMediaReseal).not.toHaveBeenCalled();
    act(() => current().setRecoveryCode("123456"));
    await start();
    expect(api.openMediaResealRun).toHaveBeenLastCalledWith("tok", { password: "pw", twoFactorCode: "123456", restart: true });
    expect(api.openMediaResealRun).toHaveBeenCalledTimes(2);
    // The code was spent on the open; the switch sends neither it nor the password.
    expect(api.rotateLibraryKey.mock.calls[0]!.slice(3, 5)).toEqual([undefined, undefined]);
    expect(current().recoveryNeedsCode).toBe(false);
  });

  it("changes the key at once, with no run and the password on the rotation, when the account stores no media", async () => {
    api.getKeyRotationReadiness.mockResolvedValue({ needsMediaReseal: false });
    await mount();
    await fillForm();
    await start();
    expect(api.openMediaResealRun).not.toHaveBeenCalled();
    expect(reseal.runMediaReseal).not.toHaveBeenCalled();
    expect(api.rotateLibraryKey.mock.calls[0]![3]).toBe("pw");
    expect(api.rotateLibraryKey.mock.calls[0]![6]).toBeUndefined();
  });

  it("finishes a refused switch on the same run without asking the password again", async () => {
    const { ApiError } = await import("@space/shared/api");
    api.rotateLibraryKey.mockRejectedValueOnce(new ApiError(409, { error: "media_reseal_incomplete", pendingFiles: 1, pendingBytes: 5 }));
    await mount();
    await fillForm();
    await start();
    expect(current().keyChange.phase).toBe("ready");
    await start();
    expect(api.openMediaResealRun).toHaveBeenCalledTimes(1);
    expect(api.rotateLibraryKey).toHaveBeenCalledTimes(2);
    expect(api.rotateLibraryKey.mock.calls[1]!.slice(3, 7)).toEqual([
      undefined,
      undefined,
      [{ appId: "parrot", blobBase64: "p", baseVersion: 1 }],
      { runId: "run-1" },
    ]);
  });
});

describe(`${SUITE} waiting on another device`, () => {
  it("waits on uploads in flight, then Switch now sends switchNow", async () => {
    const { ApiError } = await import("@space/shared/api");
    const switchNowAt = "2026-11-24T10:00:00.000Z";
    api.rotateLibraryKey.mockRejectedValueOnce(new ApiError(409, { error: "uploads_in_flight", uploadsInFlight: 3, switchNowAt }));
    await mount();
    await fillForm();
    await start();
    expect(current().keyChange.phase).toBe("waiting");
    expect(current().keyChange.uploadsInFlight).toBe(3);
    expect(current().keyChange.switchNowAt).toBe(switchNowAt);
    expect(current().recoveryError).toBeNull();
    await act(async () => await current().keyChange.switchNow());
    expect(api.rotateLibraryKey).toHaveBeenCalledTimes(2);
    expect(api.rotateLibraryKey.mock.calls[1]![6]).toEqual({ runId: "run-1", switchNow: true });
  });
});

describe(`${SUITE} stop`, () => {
  it("ends the re-seal, deletes the run's copies and closes with nothing changed", async () => {
    reseal.runMediaReseal.mockImplementation((_io, _keys, options: { signal: AbortSignal }) => {
      const { promise, resolve } = Promise.withResolvers<{ copied: number; kept: number; stopped: boolean }>();
      options.signal.addEventListener("abort", () => resolve({ copied: 1, kept: 0, stopped: true }));
      return promise;
    });
    await mount();
    await fillForm();
    let started: Promise<void> | null = null;
    act(() => {
      started = current().submitRecovery();
    });
    await flush();
    expect(current().keyChange.phase).toBe("resealing");
    // The dialog does not close while the key change runs.
    act(() => current().setRecoveryOpen(false));
    expect(current().recoveryOpen).toBe(true);
    await act(async () => await current().keyChange.stop());
    await act(async () => await started);
    console.log(`${SUITE} abandon=${JSON.stringify(api.abandonMediaResealRun.mock.calls)}`);
    expect(api.abandonMediaResealRun).toHaveBeenCalledWith("tok", "run-1");
    expect(api.rotateLibraryKey).not.toHaveBeenCalled();
    expect(current().keyChange.phase).toBe("form");
    expect(current().recoveryOpen).toBe(false);
  });
});
