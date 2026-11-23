import { beforeAll, describe, expect, it, vi } from "vitest";
import { changeLanguage, initI18n, translate } from "../src/i18n";
import { generateDeviceKeyPair, openSealedKey, pairingCheckCode, pairingCommitment } from "@space/pairing-crypto";
import {
  approvalQuestion,
  approveDevice,
  checkDevice,
  denyDevice,
  deviceTypeLabel,
  lookupDevice,
  PairingFlowError,
  pairingErrorMessage,
  sessionDeviceType,
  type PairingDeps,
  type PairingRequestInfo,
} from "../src/pairing-approve";

beforeAll(async () => {
  await initI18n("en");
});

const NOW = Date.parse("2026-10-16T12:00:00Z");
const libraryKeyBytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const libraryKey = Buffer.from(libraryKeyBytes).toString("base64");

// sf-pair-v2 numbers of the waiting device (vectors-v2.json uses the same fills).
const requesterNonce = Buffer.alloc(32, 0x11).toString("base64");

/** A request as a v2 device sends it, already checked (`check`), so approve tests start where the screen does. */
const makeRequest = (overrides: Partial<PairingRequestInfo> = {}): PairingRequestInfo => {
  const publicKey = overrides.publicKey ?? generateDeviceKeyPair().publicKey;
  return {
    requestId: "req-1",
    deviceType: "kodi",
    deviceName: "Living room Kodi",
    publicKey,
    expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    protocol: 2,
    // A malformed key (the bad-key test) has no commitment of its own.
    commitment: "commitment" in overrides ? overrides.commitment : pairingCommitment(publicKey, requesterNonce),
    check: { code: "067383", confirmedByQr: false },
    ...overrides,
  };
};

const makeDeps = (overrides: Partial<PairingDeps> = {}): PairingDeps => ({
  lookup: vi.fn(async () => makeRequest()),
  approve: vi.fn(async () => ({ ok: true, sessionId: "sess-9" })),
  deny: vi.fn(async () => ({ ok: true })),
  getLibraryKey: vi.fn(async () => libraryKey),
  requireUnlock: vi.fn(async () => undefined),
  now: () => NOW,
  keyOpensAccount: vi.fn(async () => true),
  connect: vi.fn(async () => undefined),
  readReveal: vi.fn(async () => ({ status: "pending", requesterNonce })),
  ...overrides,
});

const apiError = (status: number, error: string) => Object.assign(new Error(error), { status, payload: { error } });

describe("pairing: look up a code", () => {
  // @req ACCT-PAIR-01
  it("accepts the code with or without the dash, in any case, and from a pairing link", async () => {
    const deps = makeDeps();
    await lookupDevice(deps, "tok", "abcd-efgh");
    await lookupDevice(deps, "tok", "ABCDEFGH");
    await lookupDevice(deps, "tok", "https://spacefleet.io/pair/parrot?code=ABCD-EFGH");
    const codes = vi.mocked(deps.lookup).mock.calls.map((call) => call[1]);
    expect(new Set(codes).size).toBe(1);
    expect(codes[0]).toMatch(/^[A-Z0-9]{8}$/);
  });

  // @req ACCT-PAIR-01
  it("refuses something that is not a code without asking the server", async () => {
    const deps = makeDeps();
    await expect(lookupDevice(deps, "tok", "hello")).rejects.toMatchObject({ kind: "invalid_code" });
    expect(deps.lookup).not.toHaveBeenCalled();
  });

  // @req ACCT-PAIR-01
  it("explains an unknown, expired and already-used code in plain English", async () => {
    const cases: Array<[number, string, string]> = [
      [404, "pairing_not_found", "not_found"],
      [410, "pairing_expired", "expired"],
      [409, "pairing_already_used", "already_used"],
    ];
    for (const [status, code, kind] of cases) {
      const deps = makeDeps({
        lookup: vi.fn(async () => {
          throw apiError(status, code);
        }),
      });
      const failure = await lookupDevice(deps, "tok", "ABCD-EFGH").catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(PairingFlowError);
      expect(failure).toMatchObject({ kind, message: expect.stringMatching(/code/i) });
    }
  });

  // @req ACCT-PAIR-01
  it("rejects a code whose time has already run out", async () => {
    const deps = makeDeps({ lookup: vi.fn(async () => makeRequest({ expiresAt: new Date(NOW - 1000).toISOString() })) });
    await expect(lookupDevice(deps, "tok", "ABCD-EFGH")).rejects.toMatchObject({ kind: "expired" });
  });

  // @req ACCT-PAIR-02 @req ACCT-PAIR-05
  it("[pair-question-1] asks '<App> on <name> (<type>) wants to sign in to your account.'", () => {
    const parrot = approvalQuestion({ app: "parrot", deviceName: "Studio laptop", deviceType: "desktop" });
    const legacy = approvalQuestion({ deviceName: "Den", deviceType: "tv" });
    console.info("[pair-question-1]", { parrot, legacy });
    expect(parrot).toBe("Parrot on Studio laptop (Computer) wants to sign in to your account.");
    expect(approvalQuestion({ app: "badger", deviceName: "Living room Kodi", deviceType: "kodi" })).toBe(
      "Badger on Living room Kodi (Kodi) wants to sign in to your account.",
    );
    // A lookup from an API that does not send `app` yet is Badger's.
    expect(legacy).toBe("Badger on Den (TV) wants to sign in to your account.");
  });

  // @req ACCT-PAIR-02
  // @req ACCT-PAIR-01 @req ACCT-PAIR-05
  it("[pair-question-key] asks for the library key, not a sign-in, when the device is already signed in", () => {
    expect(approvalQuestion({ app: "parrot", purpose: "key", deviceName: "Parrot (Pixel 8)", deviceType: "mobile" })).toBe(
      "Parrot on Parrot (Pixel 8) (Phone) is signed in to your account and wants your media library key.",
    );
  });

  it("warns that a code sent by someone gives access to the whole library", () => {
    const warning = translate("pairing.warning");
    expect(warning).toContain("Only scan codes shown on a screen in front of you");
    expect(warning).toContain("access to your whole media library");
  });
});

describe("pairing: approve", () => {
  // @req ACCT-PAIR-01
  it("seals the library key to the new device so only its private key opens it, and sends only the sealed blob", async () => {
    const pair = generateDeviceKeyPair();
    const request = makeRequest({ publicKey: pair.publicKey });
    const deps = makeDeps();
    const result = await approveDevice(deps, "tok", request);

    expect(result).toEqual({ sessionId: "sess-9" });
    expect(deps.approve).toHaveBeenCalledTimes(1);
    const [token, requestId, sealed] = vi.mocked(deps.approve).mock.calls[0];
    expect(token).toBe("tok");
    expect(requestId).toBe("req-1");
    expect(Object.keys(sealed).sort()).toEqual(["ct", "epk", "iv", "v"]);
    expect(JSON.stringify(sealed)).not.toContain(libraryKey);
    const opened = openSealedKey({ devicePrivateKey: pair.privateKey, requestId, sealed });
    expect(Buffer.from(opened).toString("base64")).toBe(libraryKey);
  });

  // @req ACCT-PAIR-02
  it("asks for the phone's unlock before the key is read or anything is sent", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      getLibraryKey: vi.fn(async () => {
        order.push("read-key");
        return libraryKey;
      }),
      requireUnlock: vi.fn(async () => {
        order.push("unlock");
      }),
      approve: vi.fn(async () => {
        order.push("approve");
        return { ok: true };
      }),
    });
    await approveDevice(deps, "tok", makeRequest());
    expect(order).toEqual(["read-key", "unlock", "approve"]);
  });

  // @req ACCT-PAIR-02
  it("sends nothing when the phone has no screen lock, explaining why", async () => {
    const deps = makeDeps({
      requireUnlock: vi.fn(async () => {
        throw new PairingFlowError("no_device_lock");
      }),
    });
    const failure = await approveDevice(deps, "tok", makeRequest()).catch((e: unknown) => e);
    expect(failure).toMatchObject({ kind: "no_device_lock" });
    expect(pairingErrorMessage("no_device_lock")).toMatch(/screen lock/);
    expect(deps.approve).not.toHaveBeenCalled();
  });

  // @req ACCT-PAIR-02
  it("sends nothing when the unlock is cancelled or fails", async () => {
    const cancelled = makeDeps({
      requireUnlock: vi.fn(async () => {
        throw new PairingFlowError("unlock_cancelled");
      }),
    });
    await expect(approveDevice(cancelled, "tok", makeRequest())).rejects.toMatchObject({ kind: "unlock_cancelled" });
    expect(cancelled.approve).not.toHaveBeenCalled();

    const broken = makeDeps({
      requireUnlock: vi.fn(async () => {
        throw new Error("keystore exploded");
      }),
    });
    await expect(approveDevice(broken, "tok", makeRequest())).rejects.toMatchObject({ kind: "unlock_failed" });
    expect(broken.approve).not.toHaveBeenCalled();
  });

  // @req ACCT-PAIR-02
  it("does not unlock or send when this phone has no library key", async () => {
    const deps = makeDeps({ getLibraryKey: vi.fn(async () => null) });
    await expect(approveDevice(deps, "tok", makeRequest())).rejects.toMatchObject({ kind: "no_library_key" });
    expect(deps.requireUnlock).not.toHaveBeenCalled();
    expect(deps.approve).not.toHaveBeenCalled();
  });

  // @req ACCT-PAIR-02
  it("does not approve a request that expired while the screen was open", async () => {
    const deps = makeDeps();
    const stale = makeRequest({ expiresAt: new Date(NOW - 1).toISOString() });
    await expect(approveDevice(deps, "tok", stale)).rejects.toMatchObject({ kind: "expired" });
    expect(deps.requireUnlock).not.toHaveBeenCalled();
    expect(deps.approve).not.toHaveBeenCalled();
  });

  // @req ACCT-PAIR-01
  it("maps the server's answers on approve to plain-English errors", async () => {
    const cases: Array<[number, string, string]> = [
      [410, "pairing_expired", "expired"],
      [409, "pairing_already_used", "already_used"],
      [404, "pairing_not_found", "not_found"],
    ];
    for (const [status, code, kind] of cases) {
      const deps = makeDeps({
        approve: vi.fn(async () => {
          throw apiError(status, code);
        }),
      });
      await expect(approveDevice(deps, "tok", makeRequest())).rejects.toMatchObject({ kind });
    }
    const offline = makeDeps({
      approve: vi.fn(async () => {
        throw new TypeError("Network request failed");
      }),
    });
    await expect(approveDevice(offline, "tok", makeRequest())).rejects.toMatchObject({ kind: "network" });
  });

  // @req ACCT-PAIR-01
  it("refuses a malformed device public key instead of sending something broken", async () => {
    const deps = makeDeps();
    await expect(approveDevice(deps, "tok", makeRequest({ publicKey: "not-a-key", commitment: null }))).rejects.toMatchObject({
      kind: "bad_request",
    });
    expect(deps.approve).not.toHaveBeenCalled();
  });

  // @req ACCT-PAIR-02
  it("lets the owner deny a request", async () => {
    const deps = makeDeps();
    await denyDevice(deps, "tok", makeRequest());
    expect(deps.deny).toHaveBeenCalledWith("tok", "req-1");
    expect(deps.approve).not.toHaveBeenCalled();
  });
});

describe("pairing: check code (sf-pair-v2)", () => {
  // @req PRIV-PAIR-01
  it("[pair-mobile-check-1] exchanges the random numbers and works out the same six digits as the waiting device", async () => {
    const T = "[pair-mobile-check-1]";
    const pair = generateDeviceKeyPair();
    let approverNonce = "";
    const deps = makeDeps({
      connect: vi.fn(async (_token: string, _id: string, nonce: string) => {
        approverNonce = nonce;
      }),
    });
    const found = makeRequest({ publicKey: pair.publicKey, check: undefined });
    const checked = await checkDevice(deps, "tok", found);
    const onDevice = pairingCheckCode({ publicKey: pair.publicKey, commitment: found.commitment!, approverNonce, requesterNonce });
    console.info(T, "codes", { phone: checked.check.code, device: onDevice });
    expect(checked.check).toEqual({ code: onDevice, confirmedByQr: false });
    expect(deps.connect).toHaveBeenCalledWith("tok", "req-1", approverNonce);
    expect(deps.approve).not.toHaveBeenCalled();
  });

  // @req PRIV-PAIR-01
  it("[pair-mobile-check-2] refuses a device whose number does not open its commitment, sending nothing", async () => {
    const deps = makeDeps({ readReveal: vi.fn(async () => ({ status: "pending", requesterNonce: Buffer.alloc(32, 0x33).toString("base64") })) });
    await expect(checkDevice(deps, "tok", makeRequest({ check: undefined }))).rejects.toMatchObject({ kind: "check_failed" });
    expect(deps.approve).not.toHaveBeenCalled();
    expect(pairingErrorMessage("check_failed")).toMatch(/nothing was shared/);
  });

  // @req PRIV-PAIR-02
  it("[pair-mobile-stale] does not connect when this phone's key no longer opens the account", async () => {
    const deps = makeDeps({ keyOpensAccount: vi.fn(async () => false) });
    await expect(checkDevice(deps, "tok", makeRequest({ check: undefined }))).rejects.toMatchObject({ kind: "stale_key" });
    expect(deps.connect).not.toHaveBeenCalled();
    expect(deps.approve).not.toHaveBeenCalled();
  });

  // @req PRIV-PAIR-04
  it("[pair-mobile-v1] refuses a device from before the check: update it first", async () => {
    const deps = makeDeps({ lookup: vi.fn(async () => makeRequest({ protocol: 1, commitment: null, check: undefined })) });
    await expect(lookupDevice(deps, "tok", "ABCDEFGH")).rejects.toMatchObject({ kind: "update_required" });
    await expect(approveDevice(deps, "tok", makeRequest({ check: undefined }))).rejects.toMatchObject({ kind: "update_required" });
    expect(deps.approve).not.toHaveBeenCalled();
    expect(pairingErrorMessage("update_required")).toMatch(/older version/);
  });
});

describe("device list wording", () => {
  // @req ACCT-DEV-01
  it("labels each device type in plain English", () => {
    expect(deviceTypeLabel("mobile")).toBe("Phone");
    expect(deviceTypeLabel("desktop")).toBe("Computer");
    expect(deviceTypeLabel("tv")).toBe("TV");
    expect(deviceTypeLabel("kodi")).toBe("Kodi");
    expect(deviceTypeLabel("jellyfin")).toBe("Jellyfin server");
    expect(deviceTypeLabel("web")).toBe("Web browser");
  });

  // @req ACCT-DEV-01
  it("works out the type of older sessions from the client they signed in with", () => {
    expect(sessionDeviceType({ deviceType: "tv", clientType: "badger-desktop" })).toBe("tv");
    expect(sessionDeviceType({ clientType: "client-mobile" })).toBe("mobile");
    expect(sessionDeviceType({ clientType: "client-desktop" })).toBe("desktop");
    expect(sessionDeviceType({ clientType: "badger-kodi" })).toBe("kodi");
    expect(sessionDeviceType({ clientType: "badger-web" })).toBe("web");
    // @req ACCT-PAIR-05 a Parrot sign-in through pairing
    expect(sessionDeviceType({ clientType: "parrot-desktop" })).toBe("desktop");
  });

  // @req ACCT-DEV-01
  it("says signing out stops library access but the key cannot be taken back", () => {
    const explanation = translate("account.devices.confirmExplanation");
    expect(explanation).toContain("stops its access to your media library");
    expect(explanation).toContain("key itself can't be taken back");
  });

  // @req UX-I18N-02[badger-mobile]
  it("speaks the UI language, not just English", async () => {
    await changeLanguage("fr");
    try {
      expect(deviceTypeLabel("mobile")).toBe("Téléphone");
      expect(approvalQuestion({ app: "parrot", deviceName: "Den", deviceType: "tv" })).toBe("Parrot sur Den (TV) veut se connecter à votre compte.");
      expect(deviceTypeLabel("web")).toBe("Navigateur web");
      expect(pairingErrorMessage("expired")).toMatch(/expiré/);
    } finally {
      await changeLanguage("en");
    }
  });
});

describe("too many attempts", () => {
  // @req ACCT-AUTH-11
  it("a 429 says when to try again, from the API's retryAfterSeconds, in the UI language", async () => {
    const limited = (retryAfterSeconds?: number) =>
      Object.assign(new Error("rate_limited"), { status: 429, payload: { error: "rate_limited", ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) } });
    const failure = async (error: unknown) =>
      lookupDevice(makeDeps({ lookup: vi.fn(async () => Promise.reject(error)) }), "tok", "ABCD-EFGH").then(
        () => {
          throw new Error("expected a refusal");
        },
        (e: unknown) => e as PairingFlowError,
      );

    const minutes3 = await failure(limited(170));
    console.info("[pairing-approve-flow:429] en", { kind: minutes3.kind, minutes: minutes3.retryAfterMinutes, message: minutes3.message });
    expect(minutes3.kind).toBe("rate_limited");
    expect(minutes3.retryAfterMinutes).toBe(3);
    expect(pairingErrorMessage(minutes3.kind, minutes3.retryAfterMinutes)).toBe("Too many attempts. Try again in 3 minutes.");
    expect(minutes3.message).toBe("Too many attempts. Try again in 3 minutes.");

    const proxy = await failure(limited());
    expect(pairingErrorMessage(proxy.kind, proxy.retryAfterMinutes)).toBe("Too many attempts. Try again in 15 minutes.");

    await changeLanguage("nl");
    try {
      const one = await failure(limited(30));
      console.info("[pairing-approve-flow:429] nl", { message: pairingErrorMessage(one.kind, one.retryAfterMinutes) });
      expect(pairingErrorMessage(one.kind, one.retryAfterMinutes)).toBe("Te veel pogingen. Probeer het over 1 minuut opnieuw.");
    } finally {
      await changeLanguage("en");
    }
  });
});

describe("app-neutral wording", () => {
  // Badger and Parrot both approve with these texts (ACCT-PAIR-01), so none of them may name one app.
  // @req ACCT-PAIR-01
  it.each(["en", "fr", "nl", "de"])("no approver text names Badger in %s", async (language) => {
    await changeLanguage(language);
    try {
      const texts = [
        translate("pairing.scan.cameraDenied"),
        pairingErrorMessage("invalid_code"),
        pairingErrorMessage("network"),
        pairingErrorMessage("no_library_key"),
      ];
      console.info("[pairing-approve-flow] wording", language, JSON.stringify(texts));
      for (const text of texts) {
        expect(text).not.toMatch(/badger|parrot/i);
        expect(text).not.toMatch(/^pairing\./);
      }
    } finally {
      await changeLanguage("en");
    }
  });
});
