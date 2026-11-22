/**
 * @req ACCT-PAIR-07 @req PRIV-KEY-05
 * Same-device sign-in: a signed-in Badger approves the pairing request of Parrot on the same computer or phone (and
 * the reverse) with no password and no typed code, after checking the request really is its sister app's, on this
 * kind of device, for a sign-in, and not expired. The sealed key goes back to the asking app over the local channel:
 * the API is only told to approve (`localKey`), so the server never sees the key, not even sealed. Real sealing;
 * only the API is faked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApprovePairingError,
  createPairingClientCore,
  sealLibraryKey,
  base64ToBytes,
  approveSiblingRequest,
  bytesToBase64,
  checkSiblingAccount,
  checkSiblingRequest,
  generateDeviceKeyPair,
  openSealedKey,
  refuseSiblingRequest,
  siblingAppOf,
  type DeviceKeyPair,
  type SiblingApproveDeps,
  type PairingRequestInfo,
} from "../src";
import type { SpaceAppId } from "@space/shared/appScope";

const SUITE = "[pairing-sibling]";
/** An app id neither Badger nor Parrot, as an older or foreign client could send it: typed past SpaceAppId on purpose. */
const OTHER_APP = "other-app" as unknown as SpaceAppId;
const LIBRARY_KEY = bytesToBase64(Uint8Array.from({ length: 32 }, (_, i) => 7 + i));

describe("same-device sibling approval", () => {
  let parrot: DeviceKeyPair;
  let state: "pending" | "approved" | "denied";
  let sentToApi: unknown[];
  let deps: SiblingApproveDeps;
  let request: PairingRequestInfo;
  const expectParrot = { asker: "parrot" as const, deviceType: "desktop", deviceName: "Linux desktop" };

  beforeEach(() => {
    parrot = generateDeviceKeyPair();
    state = "pending";
    sentToApi = [];
    request = {
      requestId: "req-parrot",
      app: "parrot",
      purpose: "sign_in",
      deviceType: "desktop",
      deviceName: "Linux desktop",
      publicKey: parrot.publicKey,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    deps = {
      lookup: vi.fn(async (_token: string, code: string) => {
        if (code !== "ABCDEFGH" || state !== "pending") throw Object.assign(new Error("nf"), { status: 404, payload: { error: "pairing_not_found" } });
        return request;
      }),
      approveLocal: vi.fn(async (...args: unknown[]) => {
        sentToApi.push(args);
        if (state !== "pending") throw Object.assign(new Error("used"), { status: 409, payload: { error: "pairing_already_used" } });
        state = "approved";
        return { ok: true, sessionId: "sess-parrot" };
      }),
      deny: vi.fn(async () => {
        state = "denied";
        return { ok: true };
      }),
      getLibraryKey: vi.fn(async () => LIBRARY_KEY),
      now: () => Date.now(),
      log: (message, extra) => console.info(SUITE, message, extra ?? ""),
    };
  });

  it("names each app's sister", () => {
    expect(siblingAppOf("badger")).toBe("parrot");
    expect(siblingAppOf("parrot")).toBe("badger");
    expect(siblingAppOf(OTHER_APP)).toBeNull();
  });

  it("approves its sister's request with no password or code and returns the key sealed for that request only", async () => {
    const result = await approveSiblingRequest(deps, "badger-token", "abcd-efgh", expectParrot);
    console.info(SUITE, "approved", { sessionId: result.sessionId, sentToApi });
    expect(result.sessionId).toBe("sess-parrot");
    expect(state).toBe("approved");
    expect(sentToApi).toEqual([["badger-token", "req-parrot"]]);
    const opened = openSealedKey({ devicePrivateKey: parrot.privateKey, requestId: "req-parrot", sealed: result.sealedKey });
    expect(bytesToBase64(opened)).toBe(LIBRARY_KEY);
    expect(JSON.stringify(result.sealedKey)).not.toContain(LIBRARY_KEY);
    // The key is opened only with this request's id bound in: a copy replayed for another request does not open.
    expect(() => openSealedKey({ devicePrivateKey: parrot.privateKey, requestId: "req-other", sealed: result.sealedKey })).toThrow();
  });

  it.each([
    ["another app", { app: OTHER_APP }, "wrong_app"],
    ["the approver's own app", { app: "badger" as const }, "wrong_app"],
    ["another kind of device", { deviceType: "tv" }, "wrong_device_type"],
    ["another computer", { deviceName: "Windows (attacker)" }, "wrong_device"],
    ["a key-only request", { purpose: "key" as const }, "key_request"],
  ])("refuses %s without approving or denying", async (_label, patch, reason) => {
    request = { ...request, ...patch };
    expect(checkSiblingRequest(request, expectParrot)).toBe(reason);
    await expect(approveSiblingRequest(deps, "badger-token", "ABCDEFGH", expectParrot)).rejects.toMatchObject({ kind: "bad_request" });
    expect(deps.approveLocal).not.toHaveBeenCalled();
    expect(deps.deny).not.toHaveBeenCalled();
    expect(state).toBe("pending");
  });

  it("skips the device-name check when the OS already named the caller (phones)", () => {
    request = { ...request, deviceType: "mobile", deviceName: "Pixel 8" };
    expect(checkSiblingRequest(request, { asker: "parrot", deviceType: "mobile" })).toBeNull();
  });

  it("refuses an expired request", async () => {
    request = { ...request, expiresAt: new Date(Date.now() - 1000).toISOString() };
    await expect(approveSiblingRequest(deps, "badger-token", "ABCDEFGH", expectParrot)).rejects.toBeInstanceOf(ApprovePairingError);
    expect(deps.approveLocal).not.toHaveBeenCalled();
  });

  it("refuses a missing library key before anything is sent", async () => {
    deps.getLibraryKey = vi.fn(async () => null);
    await expect(approveSiblingRequest(deps, "badger-token", "ABCDEFGH", expectParrot)).rejects.toMatchObject({ kind: "no_library_key" });
    expect(deps.approveLocal).not.toHaveBeenCalled();
  });

  it("Cancel denies its sister's request so the asking app stops waiting at once", async () => {
    await refuseSiblingRequest(deps, "badger-token", "ABCDEFGH", expectParrot);
    expect(state).toBe("denied");
    expect(deps.approveLocal).not.toHaveBeenCalled();
  });

  it("Cancel never denies a request that is not its sister's", async () => {
    request = { ...request, app: OTHER_APP };
    await expect(refuseSiblingRequest(deps, "badger-token", "ABCDEFGH", expectParrot)).rejects.toMatchObject({ kind: "bad_request" });
    expect(deps.deny).not.toHaveBeenCalled();
  });
});

/** @req ACCT-PAIR-07 the asking app: its token comes from the API, its key only from the sister app. */
describe("same-device sign-in, asking side", () => {
  const setup = () => {
    let publicKey = "";
    let polls = 0;
    const fetchImpl = (async (request: Request) => {
      if (request.method === "POST") {
        publicKey = ((await request.json()) as { publicKey: string }).publicKey;
        return Response.json(
          { requestId: "req-local", pollSecret: "s", shortCode: "ABCD-EFGH", qrPayload: "https://spacefleet.io/pair/parrot?code=ABCDEFGH", expiresAt: "2099-01-01T00:00:00.000Z" },
          { status: 201 },
        );
      }
      polls += 1;
      return Response.json({ status: "approved", token: "tok-parrot", user: { id: "u1", email: "chris@example.com" }, localKey: true, clientType: "parrot-desktop" });
    }) as unknown as typeof fetch;
    const core = createPairingClientCore({
      appId: "parrot",
      getApiBaseUrl: () => "http://api.test",
      deviceType: "desktop",
      deviceName: () => "my-desktop",
      fallbackDeviceName: "Computer",
      fetchImpl,
      log: (message, extra) => console.info(SUITE, "client", message, extra ?? ""),
    });
    const seal = (requestId = "req-local") =>
      sealLibraryKey({ devicePublicKey: publicKey, requestId, libraryKey: base64ToBytes(LIBRARY_KEY) });
    return { core, seal, polls: () => polls };
  };

  it("opens the key the sister app handed over and keeps the token the API sent", async () => {
    const { core, seal } = setup();
    const created = await core.start();
    expect(core.deliverLocalKey(created.requestId, seal())).toBe(true);
    const polled = await core.poll(created.requestId);
    console.info(SUITE, "approved", polled.status);
    expect(polled).toEqual({ status: "approved", token: "tok-parrot", user: { id: "u1", email: "chris@example.com" }, libraryKey: LIBRARY_KEY });
  });

  it("keeps the once-only token while the key is still on its way, and finishes when it arrives", async () => {
    const { core, seal, polls } = setup();
    const created = await core.start();
    expect((await core.poll(created.requestId)).status).toBe("pending");
    expect(core.deliverLocalKey(created.requestId, seal())).toBe(true);
    const polled = await core.poll(created.requestId);
    console.info(SUITE, "late key", polled.status, "polls", polls());
    expect(polled).toMatchObject({ status: "approved", token: "tok-parrot", libraryKey: LIBRARY_KEY });
    expect(polls()).toBe(1);
  });

  it("refuses a key sealed for another request", async () => {
    const { core, seal } = setup();
    const created = await core.start();
    expect(core.deliverLocalKey(created.requestId, seal("req-other"))).toBe(false);
    expect(core.deliverLocalKey("req-other", seal("req-other"))).toBe(false);
  });
});

describe("same-device sign-in, the account the asking app ends up in", () => {
  const user = { id: "u-1", email: "Ada@Example.com" };

  it("accepts the account the sister app said it is signed in to", () => {
    const byId = checkSiblingAccount(user, { userId: "u-1", email: "ada@example.com" });
    const byEmail = checkSiblingAccount(user, { email: " ada@example.com " });
    console.info(SUITE, "account match", { byId, byEmail });
    expect(byId).toBe(true);
    expect(byEmail).toBe(true);
  });

  it("refuses another account, as when a leaked code was approved by someone else", () => {
    const otherId = checkSiblingAccount({ id: "u-2", email: "ada@example.com" }, { userId: "u-1", email: "ada@example.com" });
    const otherEmail = checkSiblingAccount({ id: "u-2", email: "eve@example.com" }, { email: "ada@example.com" });
    console.info(SUITE, "account mismatch", { otherId, otherEmail });
    expect(otherId).toBe(false);
    expect(otherEmail).toBe(false);
  });

  it("refuses when there is nothing to compare with", () => {
    const empty = checkSiblingAccount(user, {});
    console.info(SUITE, "no expectation", { empty });
    expect(empty).toBe(false);
  });
});
