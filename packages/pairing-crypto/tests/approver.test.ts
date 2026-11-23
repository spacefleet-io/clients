/**
 * ACCT-PAIR-01 / ACCT-PAIR-02 / PRIV-KEY-05 / PRIV-PAIR-01..04: the approver core every desktop approver runs (Badger in
 * the window, Parrot in main). Real sealing and real check codes; only the API is faked, and the fake checks the
 * password the way the API does (a wrong one is 401 `invalid_password` and leaves the request pending).
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
  newPairingNonce,
  openSealedKey,
  pairingCheckCode,
  pairingCommitment,
  pairingRequestView,
  runPairingCheck,
  withCommitmentFingerprint,
  type ApprovePairingDeps,
  type CheckedPairingRequest,
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
  let checked: CheckedPairingRequest;
  /** The asking device's secret number (PRIV-PAIR-01) and what the fake API stored on connect. */
  let requesterNonce: string;
  let connectedNonce: string | null;

  beforeEach(() => {
    browser = generateDeviceKeyPair();
    state = "pending";
    sealed = null;
    logs = [];
    requesterNonce = newPairingNonce();
    connectedNonce = null;
    request = {
      requestId: "req-web",
      deviceType: "web",
      deviceName: "Firefox on Linux",
      publicKey: browser.publicKey,
      protocol: 2,
      commitment: pairingCommitment(browser.publicKey, requesterNonce),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    checked = { ...request, app: "badger", check: { code: "000000", confirmedByQr: false } };
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
      keyOpensAccount: vi.fn(async () => true),
      connect: vi.fn(async (_token: string, _id: string, nonce: string) => {
        if (connectedNonce !== null && connectedNonce !== nonce) throw apiError(409, "pairing_already_used");
        connectedNonce = nonce;
        return { ok: true };
      }),
      // The device reveals its number only once a sending app connected, like the real one polling.
      readReveal: vi.fn(async () => (connectedNonce ? { status: "pending", requesterNonce } : { status: "pending" })),
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
    const result = await approvePairingRequest(deps, "tok", checked, PASSWORD);
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
    const result = await approvePairingResult(() => approvePairingRequest(deps, "tok", checked, "nope"));
    console.info(SUITE, "wrong password ->", JSON.stringify(result), "state", state);
    expect(result).toEqual({ ok: false, kind: "wrong_password" });
    expect(state).toBe("pending");
    expect(await approvePairingResult(() => approvePairingRequest(deps, "tok", checked, PASSWORD))).toEqual({
      ok: true,
      value: { sessionId: "sess-web" },
    });
  });

  it("@req ACCT-PAIR-02 sends nothing without a password, without a key, or once expired", async () => {
    await expect(approvePairingRequest(deps, "tok", checked, "")).rejects.toMatchObject({ kind: "password_missing" });
    vi.mocked(deps.getLibraryKey).mockResolvedValueOnce(null);
    await expect(approvePairingRequest(deps, "tok", checked, PASSWORD)).rejects.toMatchObject({ kind: "no_library_key" });
    const later = { ...deps, now: () => Date.now() + 600_000 };
    await expect(approvePairingRequest(later, "tok", checked, PASSWORD)).rejects.toMatchObject({ kind: "expired" });
    // PRIV-PAIR-01: a request that never went through the check is not approved either.
    const unchecked = { ...checked, check: undefined } as unknown as CheckedPairingRequest;
    await expect(approvePairingRequest(deps, "tok", unchecked, PASSWORD)).rejects.toMatchObject({ kind: "update_required" });
    console.info(SUITE, "approve calls", vi.mocked(deps.approve).mock.calls.length);
    expect(deps.approve).not.toHaveBeenCalled();
  });

  it("@req ACCT-AUTH-04 an account without a password proves it with a code: none asks for one, a wrong one is wrong_code", async () => {
    const asked = await approvePairingResult(() => approvePairingRequest(deps, "tok", checked, { code: "" }));
    console.info(SUITE, "code-less ->", JSON.stringify(asked), "state", state);
    expect(asked).toEqual({ ok: false, kind: "code_required", method: "email" });
    expect(deps.approve).toHaveBeenLastCalledWith("tok", "req-web", expect.any(Object), undefined, "");

    const wrong = await approvePairingResult(() => approvePairingRequest(deps, "tok", checked, { code: "000000" }));
    console.info(SUITE, "wrong code ->", JSON.stringify(wrong), "state", state);
    expect(wrong).toEqual({ ok: false, kind: "wrong_code", method: "email" });
    expect(state).toBe("pending");

    const ok = await approvePairingResult(() => approvePairingRequest(deps, "tok", checked, { code: ` ${CODE} ` }));
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
    const approved = await approvePairingResult(() => approvePairingRequest(deps, "tok", checked, PASSWORD));
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

  it("@req PRIV-PAIR-01 [pair-check-1] both screens get the same code; the QR fingerprint skips the comparison", async () => {
    const found = await lookupPairingRequest(deps, "tok", "ABCD-EFGH");
    const typed = await runPairingCheck(deps, "tok", found, null, async () => {});
    const deviceCode = pairingCheckCode({ publicKey: browser.publicKey, commitment: request.commitment!, approverNonce: connectedNonce!, requesterNonce });
    console.info("[pair-check-1]", "approver", typed.check.code, "device", deviceCode);
    expect(typed.check).toEqual({ code: deviceCode, confirmedByQr: false });
    expect(typed.check.code).toMatch(/^\d{6}$/);

    connectedNonce = null;
    const link = withCommitmentFingerprint("https://app.example/pair/ABCD-EFGH", request.commitment!);
    const scanned = await runPairingCheck(deps, "tok", found, link, async () => {});
    console.info("[pair-check-1]", "scanned", link, scanned.check.confirmedByQr);
    expect(scanned.check.confirmedByQr).toBe(true);
    // Another commitment's fingerprint proves nothing.
    connectedNonce = null;
    const other = withCommitmentFingerprint("https://app.example/pair/ABCD-EFGH", pairingCommitment(browser.publicKey, newPairingNonce()));
    expect((await runPairingCheck(deps, "tok", found, other, async () => {})).check.confirmedByQr).toBe(false);
    expect(JSON.stringify(logs)).not.toContain(typed.check.code);
  });

  it("@req PRIV-PAIR-01 [pair-check-2] a revealed number that does not open the commitment stops it: check_failed, nothing sealed", async () => {
    const found = await lookupPairingRequest(deps, "tok", "ABCD-EFGH");
    // A server in between swapped the key: its number cannot open the device's commitment.
    vi.mocked(deps.readReveal).mockResolvedValue({ status: "pending", requesterNonce: newPairingNonce() });
    const result = await approvePairingResult(() => runPairingCheck(deps, "tok", found, null, async () => {}));
    console.info("[pair-check-2]", JSON.stringify(result));
    expect(result).toEqual({ ok: false, kind: "check_failed" });
    expect(deps.approve).not.toHaveBeenCalled();
  });

  it("@req PRIV-PAIR-01 [pair-check-3] waits for the device's number, and stops when the request ends", async () => {
    const found = await lookupPairingRequest(deps, "tok", "ABCD-EFGH");
    let reads = 0;
    vi.mocked(deps.readReveal).mockImplementation(async () => (++reads < 3 ? { status: "pending" } : { status: "pending", requesterNonce }));
    const sleeps: number[] = [];
    const done = await runPairingCheck(deps, "tok", found, null, async (ms) => void sleeps.push(ms));
    console.info("[pair-check-3]", "reads", reads, "sleeps", sleeps);
    expect(reads).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(done.check.code).toMatch(/^\d{6}$/);

    connectedNonce = null;
    vi.mocked(deps.readReveal).mockResolvedValueOnce({ status: "denied" });
    await expect(runPairingCheck(deps, "tok", found, null, async () => {})).rejects.toMatchObject({ kind: "already_used" });
  });

  it("@req PRIV-PAIR-02 [pair-check-4] a key that no longer opens the account is stale_key and nothing is connected", async () => {
    const found = await lookupPairingRequest(deps, "tok", "ABCD-EFGH");
    vi.mocked(deps.keyOpensAccount).mockResolvedValueOnce(false);
    const stale = await approvePairingResult(() => runPairingCheck(deps, "tok", found, null, async () => {}));
    console.info("[pair-check-4]", JSON.stringify(stale));
    expect(stale).toEqual({ ok: false, kind: "stale_key" });
    expect(deps.connect).not.toHaveBeenCalled();
    // No verdict (offline, no probe): the receiving device checks the key again, so it goes on.
    vi.mocked(deps.keyOpensAccount).mockResolvedValueOnce(null);
    expect((await runPairingCheck(deps, "tok", found, null, async () => {})).check.code).toMatch(/^\d{6}$/);
  });

  it("@req PRIV-PAIR-04 [pair-check-5] a request without a commitment is update_required, except over the local channel", async () => {
    vi.mocked(deps.lookup).mockResolvedValue({ ...request, protocol: 1, commitment: null });
    const refused = await approvePairingResult(() => lookupPairingRequest(deps, "tok", "ABCD-EFGH"));
    console.info("[pair-check-5]", JSON.stringify(refused));
    expect(refused).toEqual({ ok: false, kind: "update_required" });
    expect((await lookupPairingRequest(deps, "tok", "ABCD-EFGH", { acceptV1: true })).requestId).toBe("req-web");
    // The API refusing the connect of an old request says the same.
    vi.mocked(deps.connect).mockRejectedValueOnce(apiError(400, "pairing_check_unsupported"));
    const viaApi = await approvePairingResult(() => runPairingCheck(deps, "tok", { ...request, app: "badger" }, null, async () => {}));
    expect(viaApi).toEqual({ ok: false, kind: "update_required" });
  });
});
