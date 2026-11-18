/**
 * ACCT-PAIR-01 / ACCT-PAIR-02 / PRIV-KEY-05: the approver core every desktop approver runs (Badger in the window,
 * Parrot in main). Real sealing; only the API is faked, and the fake checks the password the way the API does (a
 * wrong one is 401 `invalid_password` and leaves the request pending).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApprovePairingError,
  approvePairingRequest,
  approvePairingResult,
  bytesToBase64,
  denyPairingRequest,
  generateDeviceKeyPair,
  lookupPairingRequest,
  openSealedKey,
  pairingRequestView,
  type ApprovePairingDeps,
  type DeviceKeyPair,
  type PairingRequestInfo,
  type SealedKey,
} from "../src";

const SUITE = "[pairing-approver]";
const LIBRARY_KEY = bytesToBase64(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
const PASSWORD = "correct horse";
const CODE = "482913";
const apiError = (status: number | undefined, error?: string) =>
  Object.assign(new Error(error ?? "fetch failed"), status === undefined ? {} : { status, payload: error ? { error } : {} });

describe("approver core", () => {
  let browser: DeviceKeyPair;
  let state: "pending" | "approved" | "denied";
  let sealed: SealedKey | null;
  let logs: Array<[string, Record<string, unknown> | undefined]>;
  let deps: ApprovePairingDeps;
  let request: PairingRequestInfo;

  beforeEach(() => {
    browser = generateDeviceKeyPair();
    state = "pending";
    sealed = null;
    logs = [];
    request = {
      requestId: "req-web",
      deviceType: "web",
      deviceName: "Firefox on Linux",
      publicKey: browser.publicKey,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    deps = {
      lookup: vi.fn(async (_token: string, code: string) => {
        if (code !== "ABCDEFGH" || state !== "pending") throw apiError(404, "pairing_not_found");
        return request;
      }),
      approve: vi.fn(async (_token: string, _id: string, sealedKey: SealedKey, password: string | undefined, twoFactorCode?: string) => {
        if (state !== "pending") throw apiError(409, "pairing_already_used");
        if (password === undefined) {
          // ACCT-AUTH-04: an account without a password; a code-less try emails one, like the API.
          const fail = (error: string) => Object.assign(new Error(error), { status: 401, payload: { error, method: "email" } });
          if (!twoFactorCode) throw fail("two_factor_required");
          if (twoFactorCode !== CODE) throw fail("two_factor_invalid");
        } else if (password !== PASSWORD) throw apiError(401, "invalid_password");
        state = "approved";
        sealed = sealedKey;
        return { ok: true, sessionId: "sess-web" };
      }),
      deny: vi.fn(async () => {
        state = "denied";
        return { ok: true };
      }),
      getLibraryKey: vi.fn(async () => LIBRARY_KEY),
      now: () => Date.now(),
      log: (message, extra) => {
        logs.push([message, extra]);
        console.info(SUITE, message, JSON.stringify(extra ?? {}));
      },
    };
  });

  it("@req ACCT-PAIR-01 @req PRIV-KEY-05 resolves a typed code or a QR link and seals the key for that request only", async () => {
    for (const input of ["abcd-efgh", "ABCDEFGH", " abcd efgh "]) {
      const found = await lookupPairingRequest(deps, "tok", input);
      console.info(SUITE, "lookup", JSON.stringify(input), "->", found.requestId);
      expect(found.requestId).toBe("req-web");
    }
    const result = await approvePairingRequest(deps, "tok", request, PASSWORD);
    console.info(SUITE, "approve", JSON.stringify(result), "state", state);

    expect(result).toEqual({ sessionId: "sess-web" });
    expect(deps.approve).toHaveBeenCalledWith("tok", "req-web", expect.any(Object), PASSWORD, undefined);
    expect(JSON.stringify(sealed)).not.toContain(LIBRARY_KEY);
    expect(bytesToBase64(openSealedKey({ sealed: sealed!, devicePrivateKey: browser.privateKey, requestId: "req-web" }))).toBe(LIBRARY_KEY);
    // Bound to the request id: the same box does not open for another request.
    expect(() => openSealedKey({ sealed: sealed!, devicePrivateKey: browser.privateKey, requestId: "req-other" })).toThrow();
    // Nothing secret in the logs.
    expect(JSON.stringify(logs)).not.toContain(LIBRARY_KEY);
    expect(JSON.stringify(logs)).not.toContain(PASSWORD);
  });

  it("@req ACCT-PAIR-02 a wrong password is wrong_password and the request stays pending", async () => {
    const result = await approvePairingResult(() => approvePairingRequest(deps, "tok", request, "nope"));
    console.info(SUITE, "wrong password ->", JSON.stringify(result), "state", state);
    expect(result).toEqual({ ok: false, kind: "wrong_password" });
    expect(state).toBe("pending");
    expect(await approvePairingResult(() => approvePairingRequest(deps, "tok", request, PASSWORD))).toEqual({
      ok: true,
      value: { sessionId: "sess-web" },
    });
  });

  it("@req ACCT-PAIR-02 sends nothing without a password, without a key, or once expired", async () => {
    await expect(approvePairingRequest(deps, "tok", request, "")).rejects.toMatchObject({ kind: "password_missing" });
    vi.mocked(deps.getLibraryKey).mockResolvedValueOnce(null);
    await expect(approvePairingRequest(deps, "tok", request, PASSWORD)).rejects.toMatchObject({ kind: "no_library_key" });
    const later = { ...deps, now: () => Date.now() + 600_000 };
    await expect(approvePairingRequest(later, "tok", request, PASSWORD)).rejects.toMatchObject({ kind: "expired" });
    console.info(SUITE, "approve calls", vi.mocked(deps.approve).mock.calls.length);
    expect(deps.approve).not.toHaveBeenCalled();
  });

  it("@req ACCT-AUTH-04 an account without a password proves it with a code: none asks for one, a wrong one is wrong_code", async () => {
    const asked = await approvePairingResult(() => approvePairingRequest(deps, "tok", request, { code: "" }));
    console.info(SUITE, "code-less ->", JSON.stringify(asked), "state", state);
    expect(asked).toEqual({ ok: false, kind: "code_required", method: "email" });
    expect(deps.approve).toHaveBeenLastCalledWith("tok", "req-web", expect.any(Object), undefined, "");

    const wrong = await approvePairingResult(() => approvePairingRequest(deps, "tok", request, { code: "000000" }));
    console.info(SUITE, "wrong code ->", JSON.stringify(wrong), "state", state);
    expect(wrong).toEqual({ ok: false, kind: "wrong_code", method: "email" });
    expect(state).toBe("pending");

    const ok = await approvePairingResult(() => approvePairingRequest(deps, "tok", request, { code: ` ${CODE} ` }));
    console.info(SUITE, "right code ->", JSON.stringify(ok), "state", state);
    expect(ok).toEqual({ ok: true, value: { sessionId: "sess-web" } });
    expect(deps.approve).toHaveBeenLastCalledWith("tok", "req-web", expect.any(Object), undefined, CODE);
    expect(JSON.stringify(logs)).not.toContain(CODE);
  });

  it("@req ACCT-PAIR-02 maps lookup failures to the words the dialog shows", async () => {
    const cases: Array<[unknown, string]> = [
      [apiError(404, "pairing_not_found"), "not_found"],
      [apiError(410), "expired"],
      [apiError(409), "already_used"],
      [apiError(429), "rate_limited"],
      [apiError(401), "signed_out"],
      [apiError(422), "bad_request"],
      [apiError(undefined), "network"],
      [apiError(500), "unknown"],
    ];
    for (const [error, kind] of cases) {
      vi.mocked(deps.lookup).mockRejectedValueOnce(error);
      const result = await approvePairingResult(() => lookupPairingRequest(deps, "tok", "ABCD-EFGH"));
      console.info(SUITE, "lookup failure", JSON.stringify(error), "->", JSON.stringify(result));
      expect(result).toEqual({ ok: false, kind });
    }
    expect(await approvePairingResult(() => lookupPairingRequest(deps, "tok", "hello"))).toEqual({ ok: false, kind: "invalid_code" });
    vi.mocked(deps.lookup).mockResolvedValueOnce({ ...request, expiresAt: new Date(Date.now() - 1).toISOString() });
    expect(await approvePairingResult(() => lookupPairingRequest(deps, "tok", "ABCD-EFGH"))).toEqual({ ok: false, kind: "expired" });
  });

  it("@req ACCT-AUTH-11 a 429 carries the API's retryAfterSeconds across the IPC-safe result", async () => {
    const limited = Object.assign(new Error("rate_limited"), { status: 429, payload: { error: "rate_limited", retryAfterSeconds: 240 } });
    vi.mocked(deps.lookup).mockRejectedValueOnce(limited);
    const looked = await approvePairingResult(() => lookupPairingRequest(deps, "tok", "ABCD-EFGH"));
    vi.mocked(deps.approve).mockRejectedValueOnce(limited);
    const approved = await approvePairingResult(() => approvePairingRequest(deps, "tok", request, PASSWORD));
    console.info(SUITE, "429", JSON.stringify({ looked, approved }));
    expect(looked).toEqual({ ok: false, kind: "rate_limited", retryAfterSeconds: 240 });
    expect(approved).toEqual({ ok: false, kind: "rate_limited", retryAfterSeconds: 240 });
    // A proxy's 429 without a body says nothing more; the dialog then uses the default wait.
    vi.mocked(deps.lookup).mockRejectedValueOnce(apiError(429));
    expect(await approvePairingResult(() => lookupPairingRequest(deps, "tok", "ABCD-EFGH"))).toEqual({ ok: false, kind: "rate_limited" });
  });

  it("@req ACCT-PAIR-02 declining kills the code; a failed decline is reported", async () => {
    await denyPairingRequest(deps, "tok", request);
    expect(state).toBe("denied");
    vi.mocked(deps.deny).mockRejectedValueOnce(apiError(409, "pairing_already_used"));
    await expect(denyPairingRequest(deps, "tok", request)).rejects.toBeInstanceOf(ApprovePairingError);
  });

  it("the window's view of a request carries no public key; an older lookup without `app` is Badger's", () => {
    expect(pairingRequestView(request)).toEqual({
      requestId: "req-web",
      app: "badger",
      deviceType: "web",
      deviceName: "Firefox on Linux",
      purpose: "sign_in",
      expiresAt: request.expiresAt,
    });
  });

  it("@req ACCT-PAIR-05 [pairing-view-app] the view names the asking app", () => {
    const view = pairingRequestView({ ...request, app: "parrot", deviceType: "desktop", deviceName: "Studio laptop" });
    console.info("[pairing-view-app]", view);
    expect(view).toMatchObject({ app: "parrot", deviceType: "desktop", deviceName: "Studio laptop" });
  });
});
