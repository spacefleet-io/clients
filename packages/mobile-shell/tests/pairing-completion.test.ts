/**
 * @test-id TV-PAIR-COMPLETE-001
 * @level unit
 * @why After approval the TV must end in the same state as a password login plus typing the library key. If the
 *   session were set before the key is stored the library loader would route to the key screen; if a mismatching
 *   key were kept the TV would be signed in with a library it cannot read.
 */
import { describe, expect, it, vi } from "vitest";
import type { User } from "@space/shared/api";
const api = vi.hoisted(() => ({ logout: vi.fn(async () => undefined), getMe: vi.fn(), getLibraryMeta: vi.fn() }));
vi.mock("@space/shared/api", () => ({ ...api, ApiError: class ApiError extends Error {} }));

import { completePairing, createPairingCompletionDeps, type PairingCompletionDeps } from "../src/pairing";

const approved = { status: "approved" as const, token: "tok-1", user: { id: "u1", email: "a@b.test" }, libraryKey: "a2V5" };
const fullUser = { id: "u1", email: "a@b.test", plan: "pro" } as unknown as User;

const makeDeps = (calls: string[], overrides: Partial<PairingCompletionDeps> = {}): PairingCompletionDeps => ({
  fetchUser: vi.fn(async () => fullUser),
  verifyKey: vi.fn(async () => "ok" as const),
  setStoredLibraryKey: vi.fn(async () => void calls.push("key")),
  setLibraryKeyAcknowledged: vi.fn(async () => void calls.push("ack")),
  setSession: vi.fn(async () => void calls.push("session")),
  discardSession: vi.fn(async () => void calls.push("discard")),
  ...overrides,
});

describe("TV pairing completion", () => {
  it("stores the key and its acknowledgement BEFORE the session so the app skips onboarding", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls);
    const result = await completePairing(deps, approved);
    console.info("[tv-pairing-completion:state]", { calls, result });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["key", "ack", "session"]);
    expect(deps.setStoredLibraryKey).toHaveBeenCalledWith("a2V5");
    expect(deps.setSession).toHaveBeenCalledWith("tok-1", fullUser);
  });

  it("falls back to the pairing user when /auth/me cannot be read", async () => {
    const calls: string[] = [];
    console.info("[tv-pairing-completion:phase] /auth/me unreadable");
    const deps = makeDeps(calls, { fetchUser: vi.fn(async () => null) });
    const result = await completePairing(deps, approved);
    console.info("[tv-pairing-completion:state]", { calls, result, sessionUser: vi.mocked(deps.setSession).mock.calls[0]?.[1] });
    expect(result).toEqual({ ok: true });
    expect(deps.setSession).toHaveBeenCalledWith("tok-1", approved.user);
  });

  it("signs in when the key cannot be checked yet (no library on the account)", async () => {
    const calls: string[] = [];
    console.info("[tv-pairing-completion:phase] key unchecked");
    const deps = makeDeps(calls, { verifyKey: vi.fn(async () => "unchecked" as const) });
    const result = await completePairing(deps, approved);
    console.info("[tv-pairing-completion:state]", { calls, result });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["key", "ack", "session"]);
  });

  it("keeps nothing and drops the session when the key does not open the library", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, { verifyKey: vi.fn(async () => "mismatch" as const) });
    const result = await completePairing(deps, approved);
    console.info("[tv-pairing-completion:state]", { calls, result });
    expect(result).toEqual({ ok: false, reason: "key_mismatch" });
    expect(calls).toEqual(["discard"]);
    expect(deps.discardSession).toHaveBeenCalledWith("tok-1");
  });

  it("drops the session and reports a failure when saving the key throws", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      setStoredLibraryKey: vi.fn(async () => {
        throw new Error("keychain locked");
      }),
    });
    console.info("[tv-pairing-completion:phase] saving the key throws");
    const result = await completePairing(deps, approved);
    console.info("[tv-pairing-completion:state]", { calls, result, sessionCalls: vi.mocked(deps.setSession).mock.calls.length });
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(calls).toEqual(["discard"]);
    expect(deps.setSession).not.toHaveBeenCalled();
  });
});

describe("key-screen pairing completion (ACCT-PAIR-01)", () => {
  const setup = {
    library: "badger" as const,
    decrypt: async () => undefined,
    logTag: "test.pairing",
    setStoredLibraryKey: async () => undefined,
    setLibraryKeyAcknowledged: async () => undefined,
    setSession: async () => undefined,
  };

  it("[key-pair-keep-1] never signs out the device's own session when the key is refused", async () => {
    api.logout.mockClear();
    await createPairingCompletionDeps({ ...setup, keepSession: true }).discardSession("own-token");
    expect(api.logout).not.toHaveBeenCalled();
    await createPairingCompletionDeps(setup).discardSession("new-token");
    expect(api.logout).toHaveBeenCalledWith("new-token");
  });
});
