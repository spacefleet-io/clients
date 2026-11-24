/**
 * @test-id PARROT-DESKTOP-KEY-CHANGE-MAIN-001
 * @level unit (`createParrotKeyChange` with a fake controller; no network)
 * @req ACCT-KEYCHG-01[parrot] ACCT-KEYCHG-03[parrot] ACCT-KEYCHG-04[parrot] ACCT-KEYCHG-06[parrot] ACCT-KEYCHG-08[parrot]
 * @why Parrot desktop changes the media library key in main, on the controller Badger desktop runs (Chris
 *   2026-11-23 Q2). The window only sees plain answers over IPC: a code request, a refusal's reason, a switch (after
 *   which main keeps the new key and signs out), a stop. Each dialog opening is one key change with its own key.
 */
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@space/shared/api";
import { KEY_CHANGE_IDLE, type KeyChange, type KeyChangeApp, type KeyChangeOptions, type KeyChangeState } from "@space/media-reseal";
import { createParrotKeyChange, type ParrotKeyChangeDeps } from "../src/main/keyChange";

const SUITE = "[PARROT-DESKTOP-KEY-CHANGE-MAIN-001]";

const app: KeyChangeApp = {
  appId: "parrot",
  oldKey: async () => "old-key",
  sealOwnLibrary: async () => {
    throw new Error("not used");
  },
  reencryptOtherLibraries: async () => [],
  keyProbe: async () => "probe",
};

const fakeChange = (overrides: Partial<KeyChange> = {}): KeyChange => {
  let phase: KeyChangeState["phase"] = "form";
  return {
    state: () => ({ ...KEY_CHANGE_IDLE, phase }),
    start: vi.fn(async () => {
      phase = "resealing";
      return "switched" as const;
    }),
    resume: vi.fn(async () => "switched" as const),
    switchNow: vi.fn(async () => "switched" as const),
    poll: vi.fn(async () => null),
    stop: vi.fn(async () => undefined),
    pause: vi.fn(),
    unreadableFiles: vi.fn(async () => [{ key: "media/a", sizeBytes: 3 }]),
    deleteUnreadableFiles: vi.fn(async () => undefined),
    ...overrides,
  };
};

const setup = (change: () => KeyChange, token: string | null = "tok") => {
  const made: Array<{ options: KeyChangeOptions; change: KeyChange }> = [];
  let n = 0;
  const deps: ParrotKeyChangeDeps = {
    token: () => token,
    newKey: () => ({ keyBase64: `key-${++n}`, words: [`word${n}`] }),
    hasPassword: vi.fn(async () => true),
    readiness: vi.fn(async () => ({ needsMediaReseal: true })),
    app: () => app,
    onState: vi.fn(),
    onSwitched: vi.fn(async () => undefined),
    log: vi.fn(),
    create: (options) => {
      const made1 = change();
      made.push({ options, change: made1 });
      return made1;
    },
  };
  return { deps, made, keyChange: createParrotKeyChange(deps) };
};

describe("@req ACCT-KEYCHG-01[parrot] Parrot desktop's key change runs in main", () => {
  it(`${SUITE} opening makes a new key and its own key change; the words go to the window`, async () => {
    const { keyChange, made, deps } = setup(() => fakeChange());
    expect(await keyChange.open()).toEqual({ ok: true, words: ["word1"], hasPassword: true });
    expect(made[0]?.options).toMatchObject({ token: "tok", newKeyBase64: "key-1" });
    expect(deps.onState).toHaveBeenCalledWith(KEY_CHANGE_IDLE);
    await keyChange.open();
    // The previous key change is paused, never finished with another key.
    expect(made[0]?.change.pause).toHaveBeenCalled();
    expect(made[1]?.options.newKeyBase64).toBe("key-2");
  });

  it(`${SUITE} signed out: nothing opens, and no readiness (the entry stays hidden)`, async () => {
    const { keyChange } = setup(() => fakeChange(), null);
    expect(await keyChange.open()).toEqual({ ok: false });
    expect(await keyChange.readiness()).toBeNull();
  });

  it(`${SUITE} the server's answer decides the entry; no answer hides it`, async () => {
    const { keyChange, deps } = setup(() => fakeChange());
    expect(await keyChange.readiness()).toEqual({ needsMediaReseal: true });
    vi.mocked(deps.readiness).mockRejectedValueOnce(new Error("offline"));
    expect(await keyChange.readiness()).toBeNull();
  });

  it(`${SUITE} start sends the password and code; the switch keeps the new key and signs out`, async () => {
    const { keyChange, made, deps } = setup(() => fakeChange());
    await keyChange.open();
    expect(await keyChange.submit("pw", "123456")).toEqual({ status: "switched" });
    expect(made[0]?.change.start).toHaveBeenCalledWith({ password: "pw", twoFactorCode: "123456" });
    expect(deps.onSwitched).toHaveBeenCalledWith("key-1");
    // Switched: nothing is left to finish.
    expect(await keyChange.submit("pw")).toEqual({ status: "failed", reason: "other" });
  });

  it(`${SUITE} Finish on an open run resumes it without asking the password again (Q1)`, async () => {
    const change = fakeChange({ state: () => ({ ...KEY_CHANGE_IDLE, phase: "ready" }) });
    const { keyChange } = setup(() => change);
    await keyChange.open();
    expect(await keyChange.submit("")).toEqual({ status: "switched" });
    expect(change.resume).toHaveBeenCalled();
    expect(change.start).not.toHaveBeenCalled();
  });

  it(`${SUITE} a code request and a refused password come back as plain data`, async () => {
    const change = fakeChange();
    vi.mocked(change.start)
      .mockRejectedValueOnce(new ApiError(401, { error: "two_factor_required", method: "totp" }))
      .mockRejectedValueOnce(new ApiError(401, { error: "invalid_password" }));
    const { keyChange, deps } = setup(() => change);
    await keyChange.open();
    expect(await keyChange.submit("pw")).toEqual({ status: "codeNeeded", method: "totp" });
    expect(await keyChange.submit("bad")).toEqual({ status: "failed", reason: "invalidPassword" });
    expect(deps.onSwitched).not.toHaveBeenCalled();
  });

  it(`${SUITE} still waiting on another device answers "waiting"; switch now switches`, async () => {
    const change = fakeChange();
    const { keyChange, deps } = setup(() => change);
    await keyChange.open();
    expect(await keyChange.poll()).toEqual({ status: "waiting" });
    expect(await keyChange.switchNow()).toEqual({ status: "switched" });
    expect(deps.onSwitched).toHaveBeenCalledWith("key-1");
  });

  it(`${SUITE} stop deletes the copies; a failed stop says why`, async () => {
    const change = fakeChange();
    vi.mocked(change.stop).mockRejectedValueOnce(new ApiError(500, { error: "internal" }));
    const { keyChange } = setup(() => change);
    await keyChange.open();
    expect(await keyChange.stop()).toEqual({ status: "failed", reason: "other" });
    expect(await keyChange.stop()).toEqual({ status: "stopped" });
    expect(change.stop).toHaveBeenCalledTimes(2);
  });

  it(`${SUITE} the unreadable files are listed and deleted; a failed delete answers false`, async () => {
    const change = fakeChange();
    const { keyChange } = setup(() => change);
    expect(await keyChange.unreadableFiles()).toEqual([]);
    await keyChange.open();
    const files = await keyChange.unreadableFiles();
    expect(files).toEqual([{ key: "media/a", sizeBytes: 3 }]);
    expect(await keyChange.deleteUnreadableFiles(files)).toBe(true);
    vi.mocked(change.deleteUnreadableFiles).mockRejectedValueOnce(new Error("boom"));
    expect(await keyChange.deleteUnreadableFiles(files)).toBe(false);
  });
});
