/**
 * @test-id TV-PAIR-APPROVE-001
 * @level unit
 * @why ACCT-PAIR-02: a TV has no fingerprint or screen lock, so it sends the ACCOUNT PASSWORD with the approval
 *   and the API checks it before approving. If a TV could approve without a password, or a wrong password were
 *   reported as "signed out", anyone holding the remote could hand the library key to another device. The API is
 *   faked with the contract of `POST /pairing/requests/:id/approve` (401 `invalid_password` leaves the request
 *   pending, 429 when guessing too fast); the phone path must keep sending no password.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "@space/mobile-shell/i18n";
import { ApiError } from "@space/shared/api";
import { bytesToBase64, generateDeviceKeyPair, openSealedKey, type SealedKey } from "@space/pairing-crypto";
import { PairingFlowError, approveDevice, type PairingDeps, type PairingRequestInfo } from "@space/mobile-shell/pairing-approve";

beforeAll(async () => {
  await initI18n("en");
});

const NOW = Date.parse("2026-10-20T10:00:00Z");
const libraryKey = bytesToBase64(Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff));
const device = generateDeviceKeyPair();
const request: PairingRequestInfo = {
  requestId: "req-tv",
  deviceType: "kodi",
  deviceName: "Living room Kodi",
  publicKey: device.publicKey,
  expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
  // Already checked (sf-pair-v2, PRIV-PAIR-01): these tests start where the TV's confirm step does.
  protocol: 2,
  check: { code: "067383", confirmedByQr: false },
};

/** The sf-pair-v2 calls, unused once a request is checked. */
const checkDeps: Pick<PairingDeps, "keyOpensAccount" | "connect" | "readReveal"> = {
  keyOpensAccount: vi.fn(async () => true),
  connect: vi.fn(async () => undefined),
  readReveal: vi.fn(async () => ({ status: "pending" })),
};

type FakeServer = { pending: boolean; calls: Array<{ password: string | undefined }>; opened: string[] };

/** The approve endpoint: checks the password (when sent) first, then approves and parks the sealed key. */
const makeDeps = (accountPassword: string, overrides: Partial<PairingDeps> = {}) => {
  const server: FakeServer = { pending: true, calls: [], opened: [] };
  const deps: PairingDeps = {
    lookup: vi.fn(async () => request),
    approve: vi.fn(async (_token: string, _id: string, sealed: SealedKey, password?: string) => {
      server.calls.push({ password });
      if (password !== undefined && password !== accountPassword) throw new ApiError(401, { error: "invalid_password" });
      server.pending = false;
      server.opened.push(
        Buffer.from(openSealedKey({ devicePrivateKey: device.privateKey, requestId: request.requestId, sealed })).toString("base64"),
      );
      return { ok: true, sessionId: "s1" };
    }),
    deny: vi.fn(async () => ({ ok: true })),
    getLibraryKey: vi.fn(async () => libraryKey),
    requireUnlock: null,
    now: () => NOW,
    ...checkDeps,
    ...overrides,
  };
  return { deps, server };
};

const kindOf = async (run: Promise<unknown>) =>
  run.then(
    () => "resolved",
    (error: unknown) => (error instanceof PairingFlowError ? error.kind : `other:${String(error)}`),
  );

describe("TV approval with the account password", () => {
  it("sends the typed password with the approval and the key reaches the new device", async () => {
    console.info("[tv-approval:phase] right password");
    const { deps, server } = makeDeps("hunter2");
    await approveDevice(deps, "tok", request, { password: "hunter2" });
    console.info("[tv-approval:state]", { calls: server.calls, pending: server.pending });
    expect(server.calls).toEqual([{ password: "hunter2" }]);
    expect(server.opened).toEqual([libraryKey]);
  });

  it("reports a wrong password as such (not as signed out), leaves the request pending, and accepts a retry", async () => {
    console.info("[tv-approval:phase] wrong then right");
    const { deps, server } = makeDeps("hunter2");
    expect(await kindOf(approveDevice(deps, "tok", request, { password: "nope" }))).toBe("wrong_password");
    expect(server.pending).toBe(true);
    expect(server.opened).toEqual([]);
    await approveDevice(deps, "tok", request, { password: "hunter2" });
    console.info("[tv-approval:state]", { calls: server.calls, pending: server.pending });
    expect(server.pending).toBe(false);
    expect(server.opened).toEqual([libraryKey]);
  });

  it("refuses to approve without a password and sends nothing", async () => {
    console.info("[tv-approval:phase] no password");
    const { deps } = makeDeps("hunter2");
    const missing = await kindOf(approveDevice(deps, "tok", request));
    const empty = await kindOf(approveDevice(deps, "tok", request, { password: "" }));
    console.info("[tv-approval:state]", { missing, empty, approveCalls: vi.mocked(deps.approve).mock.calls.length });
    expect(missing).toBe("unlock_cancelled");
    expect(empty).toBe("unlock_cancelled");
    expect(deps.approve).not.toHaveBeenCalled();
  });

  it("tells the user to wait when the API says they are guessing too fast", async () => {
    console.info("[tv-approval:phase] rate limited");
    const { deps } = makeDeps("hunter2", {
      approve: vi.fn(async () => {
        throw new ApiError(429, { error: "rate_limited" });
      }),
    });
    const kind = await kindOf(approveDevice(deps, "tok", request, { password: "whatever" }));
    console.info("[tv-approval:state]", { kind });
    expect(kind).toBe("rate_limited");
  });

  it("still reports an expired session as signed out", async () => {
    console.info("[tv-approval:phase] expired session");
    const { deps } = makeDeps("hunter2", {
      approve: vi.fn(async () => {
        throw new ApiError(401, { error: "unauthorized" });
      }),
    });
    const kind = await kindOf(approveDevice(deps, "tok", request, { password: "hunter2" }));
    console.info("[tv-approval:state]", { kind });
    expect(kind).toBe("signed_out");
  });

  it("phones keep their own unlock and send no password to the API", async () => {
    console.info("[tv-approval:phase] phone keeps unlock");
    const order: string[] = [];
    const { deps, server } = makeDeps("hunter2", {
      requireUnlock: vi.fn(async () => void order.push("unlock")),
    });
    await approveDevice(deps, "tok", request, { password: "ignored-on-phone" });
    console.info("[tv-approval:state]", { order, calls: server.calls });
    expect(order).toEqual(["unlock"]);
    expect(server.calls).toEqual([{ password: undefined }]);
  });
});

/**
 * ACCT-AUTH-04 / ACCT-PAIR-02: an account without a password proves itself with a code. The approve endpoint's
 * contract for it: no code → 401 `two_factor_required` with the `method` (an email code is sent), wrong code → 401
 * `two_factor_invalid` (still pending), right code → approved.
 */
const makeCodeDeps = (rightCode: string, method: "email" | "totp" = "email") => {
  const server = { pending: true, calls: [] as Array<{ password: string | undefined; code: string | undefined }>, opened: [] as string[] };
  const deps: PairingDeps = {
    lookup: vi.fn(async () => request),
    approve: vi.fn(async (_token: string, _id: string, sealed: SealedKey, password?: string, twoFactorCode?: string) => {
      server.calls.push({ password, code: twoFactorCode });
      if (!twoFactorCode) throw new ApiError(401, { error: "two_factor_required", method });
      if (twoFactorCode !== rightCode) throw new ApiError(401, { error: "two_factor_invalid", method });
      server.pending = false;
      server.opened.push(
        Buffer.from(openSealedKey({ devicePrivateKey: device.privateKey, requestId: request.requestId, sealed })).toString("base64"),
      );
      return { ok: true, sessionId: "s2" };
    }),
    deny: vi.fn(async () => ({ ok: true })),
    getLibraryKey: vi.fn(async () => libraryKey),
    requireUnlock: null,
    now: () => NOW,
    ...checkDeps,
  };
  return { deps, server };
};

describe("TV approval for an account without a password (ACCT-AUTH-04)", () => {
  it("asks a code first (the API emails it), refuses a wrong one with the request pending, then approves", async () => {
    console.info("[tv-approval:phase] code: first try, wrong, right");
    const { deps, server } = makeCodeDeps("123456");
    const first = await approveDevice(deps, "tok", request, { code: null }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(PairingFlowError);
    expect((first as PairingFlowError).kind).toBe("code_required");
    expect((first as PairingFlowError).codeMethod).toBe("email");
    expect((first as PairingFlowError).message).toBe("Type the code to confirm it's you.");
    expect(await kindOf(approveDevice(deps, "tok", request, { code: "000000" }))).toBe("code_invalid");
    expect(server.pending).toBe(true);
    await approveDevice(deps, "tok", request, { code: "123456" });
    console.info("[tv-approval:state]", { calls: server.calls, pending: server.pending });
    expect(server.calls).toEqual([
      { password: undefined, code: undefined },
      { password: undefined, code: "000000" },
      { password: undefined, code: "123456" },
    ]);
    expect(server.pending).toBe(false);
    expect(server.opened).toEqual([libraryKey]);
  });

  it("says when the code comes from the authenticator app", async () => {
    const { deps } = makeCodeDeps("654321", "totp");
    const first = await approveDevice(deps, "tok", request, { code: null }).catch((e: unknown) => e);
    console.info("[tv-approval:state]", { kind: (first as PairingFlowError).kind, method: (first as PairingFlowError).codeMethod });
    expect((first as PairingFlowError).codeMethod).toBe("totp");
  });
});
