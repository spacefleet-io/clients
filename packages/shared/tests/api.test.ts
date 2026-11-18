import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiRequest,
  approvePairing,
  bootstrapStatus,
  createStorageTunnelSession,
  getApiBaseUrl,
  getLibraryOps,
  getMe,
  getSettings,
  getSystemContractIssue,
  deleteAccount,
  login,
  logout,
  lookupPairing,
  sendStorageTunnelFrame,
  setApiClientType,
  updateSettings,
  updateSubscription,
  putLibraryDb,
  putLibraryDbBinary,
  putLibraryOp,
  setApiBaseUrl,
  verifyEmail,
} from "../src/api";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// On assertion failure, dump the recorded fetch calls (url + method + headers)
// so url/header mismatches are diagnosable without re-running.
const dumpSharedApiSnapshot = (label: string) => {
  try {
    // The SDK passes one Request; the hand-written calls pass (url, init).
    const calls = fetchMock.mock.calls.map(([input, init]) =>
      input instanceof Request
        ? { url: input.url, method: input.method, headers: Object.fromEntries(input.headers) }
        : {
            url: input,
            method: (init as RequestInit | undefined)?.method,
            headers: (init as RequestInit | undefined)?.headers,
          }
    );
    console.error(`=== [shared-api:${label}] snapshot ===`);
    console.error(`baseUrl=${getApiBaseUrl()}`);
    console.error(`fetch calls (${calls.length}):\n${JSON.stringify(calls, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

afterEach(() => {
  console.info(`[shared-api:teardown] resetting fetch mock + base url`);
  fetchMock.mockReset();
  setApiBaseUrl("/api");
});

describe("shared api client", () => {
  it("uses normalized base url and auth headers", async () => {
    setApiBaseUrl("https://api.spacebadger.io/");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    console.info(`[shared-api:base-url] requesting /health with token, base set to trailing-slash url`);
    const payload = await apiRequest<{ ok: boolean }>("/health", { token: "tkn" });
    try {
      expect(payload.ok).toBe(true);
      expect(getApiBaseUrl()).toBe("https://api.spacebadger.io");
      expect(fetchMock).toHaveBeenCalledWith("https://api.spacebadger.io/health", expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer tkn",
          "x-space-app": "badger",
        }),
      }));
    } catch (err) {
      dumpSharedApiSnapshot("base-url-and-headers");
      throw err;
    }
  });

  it("throws ApiError on failed request", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );

    console.info(`[shared-api:error] requesting /denied (mock returns 403)`);
    const error = await apiRequest("/denied").catch((value) => value);
    try {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toEqual(
        expect.objectContaining({
          status: 403,
          payload: expect.objectContaining({ error: "forbidden" }),
        })
      );
    } catch (err) {
      console.error(
        `[shared-api:error] thrown value=${error instanceof Error ? `${error.name}: ${error.message}` : JSON.stringify(error)}`,
      );
      dumpSharedApiSnapshot("error-on-failed-request");
      throw err;
    }
  });

  it("uploads library snapshot payload in binary mode", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ version: 2, stateHash: "s2", lastOpId: "op2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    console.info(`[shared-api:put-binary] uploading 3-byte library snapshot snap-2 in binary mode`);
    const body = new Uint8Array([1, 2, 3]);
    const result = await putLibraryDbBinary("token", 2, body, "snap-2", 4 * 1024 * 1024, "probe", true, "state", "op");

    try {
      expect(result.version).toBe(2);
      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(options.method).toBe("PUT");
      expect(options.headers).toEqual(
        expect.objectContaining({
          "Content-Type": "application/octet-stream",
          Authorization: "Bearer token",
          "x-space-app": "badger",
          "x-library-snapshot-id": "snap-2",
        })
      );
      expect(options.body).toBeInstanceOf(Uint8Array);
    } catch (err) {
      console.error(`[shared-api:put-binary] result=${JSON.stringify(result)}`);
      dumpSharedApiSnapshot("put-library-binary");
      throw err;
    }
  });

  it("declares the library formats on an op upload, and sends nothing when none are given", async () => {
    const okResponse = () =>
      new Response(JSON.stringify({ version: 4, snapshotVersion: 1, stateHash: null, lastOpId: "op-4" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    setApiBaseUrl("https://api.spacebadger.io");
    fetchMock.mockResolvedValueOnce(okResponse());
    fetchMock.mockResolvedValueOnce(okResponse());

    console.info("[shared-api:put-op-formats] posting one op with declared formats, one without");
    const payload = new Uint8Array([1, 2, 3]);
    await putLibraryOp("token", 3, "op-4", payload, undefined, undefined, { storageFormatVersion: 2, opStreamVersion: 2 });
    await putLibraryOp("token", 4, "op-5", payload);

    // The SDK passes one Request to fetch.
    const [declared] = fetchMock.mock.calls[0] as [Request];
    const [legacy] = fetchMock.mock.calls[1] as [Request];
    try {
      expect(declared.headers.get("x-library-storage-format-version")).toBe("2");
      expect(declared.headers.get("x-library-op-stream-version")).toBe("2");
      expect(legacy.headers.has("x-library-storage-format-version")).toBe(false);
      expect(legacy.headers.has("x-library-op-stream-version")).toBe(false);
    } catch (err) {
      console.error(
        `[shared-api:put-op-formats] declared=${JSON.stringify(Object.fromEntries(declared.headers))} legacy=${JSON.stringify(Object.fromEntries(legacy.headers))}`
      );
      dumpSharedApiSnapshot("put-library-op-formats");
      throw err;
    }
  });

  it("declares the library formats in the snapshot PUT body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ version: 5, stateHash: null, lastOpId: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    setApiBaseUrl("https://api.spacebadger.io");
    console.info("[shared-api:put-db-formats] publishing a snapshot with declared formats");
    await putLibraryDb(
      "token",
      4,
      "bWFuaWZlc3Q=",
      "snap-5",
      4 * 1024 * 1024,
      "probe",
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      { storageFormatVersion: 2, opStreamVersion: 2 }
    );

    const [request] = fetchMock.mock.calls[0] as [Request];
    const body = (await request.json()) as Record<string, unknown>;
    try {
      expect(body.storageFormatVersion).toBe(2);
      expect(body.opStreamVersion).toBe(2);
    } catch (err) {
      console.error(`[shared-api:put-db-formats] body=${JSON.stringify(body)}`);
      dumpSharedApiSnapshot("put-library-db-formats");
      throw err;
    }
  });

  it("creates and uses storage tunnel session routes", async () => {
    setApiBaseUrl("https://api.spacebadger.io");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          policy: {
            epoch: 1,
            generatedAt: new Date(0).toISOString(),
            shards: [
              {
                id: "shard-a",
                gatewayUrl: "https://gateway.spacebadger.io",
                // Only an `active` silo takes new data (STOR-GATEWAY-13); "online" is no shard status.
                status: "active",
                weight: 1,
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "s1",
          protocolVersion: 1,
          createdAt: 1,
          expiresAt: 2,
          features: { upload: true, download: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    // STOR-BW-11: a playback session names its profile; without one it is refused before any request.
    await expect(createStorageTunnelSession("token", "library/chunks/x")).rejects.toThrow("profile_required");
    expect(fetchMock).not.toHaveBeenCalled();

    console.info(`[shared-api:tunnel] creating session for profile p1 then sending session.start frame`);
    const session = await createStorageTunnelSession("token", "library/chunks/x", { profileId: "p1" });
    const frame = await sendStorageTunnelFrame("token", "s1", { kind: "session.start" });
    try {
      expect(session.sessionId).toBe("s1");
      expect(frame).toEqual({ kind: "session.ack" });
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://api.spacebadger.io/storage/placement",
        expect.objectContaining({ method: "GET" })
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://gateway.spacebadger.io/storage/tunnel/session",
        expect.objectContaining({ method: "POST" })
      );
      // No explicit purpose = playback (#145 unpaid access), for the named profile (STOR-BW-11).
      expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toMatchObject({ purpose: "playback", profileId: "p1" });
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        "https://gateway.spacebadger.io/storage/tunnel/frame",
        expect.objectContaining({ method: "POST" })
      );
    } catch (err) {
      console.error(
        `[shared-api:tunnel] sessionId=${session.sessionId} frame=${JSON.stringify(frame)}`,
      );
      dumpSharedApiSnapshot("storage-tunnel-session-routes");
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] computes explicit client issue from system contract", () => {
    console.info(`[shared-api:contract-issue] case 1 — badger supported=true → expect null`);
    const supportedIssue = getSystemContractIssue(
      {
          apiVersion: "2026-03-05",
          generatedAt: new Date(0).toISOString(),
          libraryProtocolVersion: 1,
          features: {
            appScopedLibrarySync: true,
            storageTunnelV2: true,
            explicitBootstrapOnly: true,
          },
          apps: {
            badger: {
              supported: true,
              releaseStage: "ga",
              minClientVersion: "0.1.0",
              dbSchemaGeneration: 1,
              libraryProtocolVersion: 1,
              migrationRequired: false,
              migrationReason: null,
            },
            parrot: {
              supported: false,
              releaseStage: "planned",
              minClientVersion: null,
              dbSchemaGeneration: 1,
              libraryProtocolVersion: 1,
              migrationRequired: false,
              migrationReason: null,
            },
          },
      },
      "badger"
    );
    if (supportedIssue !== null)
      console.error(
        `[shared-api:contract-issue] expected null for supported badger, got ${JSON.stringify(supportedIssue)}`,
      );
    expect(supportedIssue).toBeNull();

    console.info(
      `[shared-api:contract-issue] case 2 — badger supported=false, reason=maintenance_window → expect "maintenance_window"`,
    );
    const unsupportedIssue = getSystemContractIssue(
      {
          apiVersion: "2026-03-05",
          generatedAt: new Date(0).toISOString(),
          libraryProtocolVersion: 1,
          features: {
            appScopedLibrarySync: true,
            storageTunnelV2: true,
            explicitBootstrapOnly: true,
          },
          apps: {
            badger: {
              supported: false,
              releaseStage: "ga",
              minClientVersion: "0.1.0",
              dbSchemaGeneration: 1,
              libraryProtocolVersion: 1,
              migrationRequired: false,
              migrationReason: "maintenance_window",
            },
            parrot: {
              supported: false,
              releaseStage: "planned",
              minClientVersion: null,
              dbSchemaGeneration: 1,
              libraryProtocolVersion: 1,
              migrationRequired: false,
              migrationReason: null,
            },
          },
        },
        "badger"
      );
    if (unsupportedIssue !== "maintenance_window")
      console.error(
        `[shared-api:contract-issue] expected "maintenance_window" for unsupported badger, got ${JSON.stringify(unsupportedIssue)}`,
      );
    expect(unsupportedIssue).toBe("maintenance_window");
  });

});

// Account calls go through the SDK (DEV-API-02), which hands `fetch` a single Request.
describe("account calls through the SDK", () => {
  const lastRequest = () => (fetchMock.mock.calls.at(-1) as [Request])[0];
  const lastCall = async () => {
    const request = lastRequest();
    const text = await request.clone().text();
    return {
      url: request.url,
      method: request.method,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
    };
  };

  beforeEach(() => {
    setApiBaseUrl("https://api.test");
  });

  it("uses the normalized base url, the bearer token and the app scope", async () => {
    setApiBaseUrl("  https://api.spacebadger.io/api/ ");
    fetchMock.mockImplementation(async () => Response.json({ email: "a@b.c" }));
    await getSettings("tkn");
    const request = lastRequest();
    expect(getApiBaseUrl()).toBe("https://api.spacebadger.io/api");
    expect(request).toBeInstanceOf(Request);
    expect(request.url).toBe("https://api.spacebadger.io/api/account/settings");
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe("Bearer tkn");
    expect(request.headers.get("x-space-app")).toBe("badger");
  });

  it("ignores an empty base url", async () => {
    setApiBaseUrl("   ");
    expect(getApiBaseUrl()).toBe("https://api.test");
    fetchMock.mockImplementation(async () => Response.json({ email: "a@b.c" }));
    await getSettings("tkn");
    expect(lastRequest().url).toBe("https://api.test/account/settings");
  });

  it("sends no Authorization header without a token", async () => {
    fetchMock.mockImplementation(async () => Response.json({ needsSetup: false }));
    await bootstrapStatus();
    expect(lastRequest().headers.get("authorization")).toBeNull();
    expect(lastRequest().headers.get("x-space-app")).toBe("badger");
  });

  it("throws ApiError(status, payload) on a non-2xx answer", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: "forbidden" }, { status: 403 }));
    const error = await getMe("tkn").catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, message: "forbidden", payload: { error: "forbidden" } });
  });

  it("falls back to request_failed when the error body is not JSON", async () => {
    fetchMock.mockImplementation(async () => new Response("boom", { status: 502 }));
    const error = await getMe("tkn").catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, message: "request_failed", payload: {} });
  });

  it("answers undefined for a 204", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    await expect(logout("tkn")).resolves.toBeUndefined();
    expect(lastRequest().method).toBe("POST");
    expect(lastRequest().url).toBe("https://api.test/auth/logout");
  });

  it("sends the client type with login and verifyEmail", async () => {
    fetchMock.mockImplementation(async () => Response.json({ token: "t", user: {} }));
    setApiClientType("client-desktop");
    try {
      await login("a@b.c", "pw", "123456", true);
      expect(await lastCall()).toEqual({
        url: "https://api.test/auth/login",
        method: "POST",
        body: { email: "a@b.c", password: "pw", clientType: "client-desktop", twoFactorCode: "123456", resendTwoFactor: true },
      });
      await verifyEmail("a@b.c", "654321");
      expect(await lastCall()).toEqual({
        url: "https://api.test/auth/verify",
        method: "POST",
        body: { email: "a@b.c", code: "654321", clientType: "client-desktop" },
      });
      setApiClientType("   ");
      await login("a@b.c", "pw");
      expect((await lastCall()).body).toMatchObject({ clientType: "client-desktop" });
    } finally {
      setApiClientType("client-web");
    }
  });

  it("deleteAccount sends password + the literal DELETE confirmation (and the 2FA code when given)", async () => {
    fetchMock.mockImplementation(async () => Response.json({ status: "deletion_scheduled" }, { status: 202 }));
    console.info(`[shared-api:delete-account] DELETE /account with password + confirm`);
    const res = await deleteAccount("tkn", { password: "hunter2", confirm: "DELETE" });
    expect(res).toEqual({ status: "deletion_scheduled" });
    expect(await lastCall()).toEqual({
      url: "https://api.test/account",
      method: "DELETE",
      body: { password: "hunter2", confirm: "DELETE" },
    });
    await deleteAccount("tkn", { password: "hunter2", confirm: "DELETE", twoFactorCode: "123456" });
    expect((await lastCall()).body).toEqual({ password: "hunter2", confirm: "DELETE", twoFactorCode: "123456" });
  });

  it("updateSubscription sends {plan, billingPeriod} and only the optional fields that are set", async () => {
    fetchMock.mockImplementation(async () => Response.json({ user: {} }));
    await updateSubscription("tkn", "tier1", { billingPeriod: "annual" });
    expect(await lastCall()).toEqual({
      url: "https://api.test/account/subscription",
      method: "PATCH",
      body: { plan: "tier1", billingPeriod: "annual" },
    });
    await updateSubscription("tkn", "tier3", { billingPeriod: "monthly", addonCount: 2 });
    expect((await lastCall()).body).toEqual({ plan: "tier3", billingPeriod: "monthly", addonCount: 2 });
    await updateSubscription("tkn", "free");
    expect((await lastCall()).body).toEqual({ plan: "free" });
  });

  it("pushes uiLanguage through PATCH /account/settings preferences", async () => {
    fetchMock.mockImplementation(async () => Response.json({ user: {} }));
    await updateSettings("tkn", { preferences: { uiLanguage: "fr" } });
    expect(await lastCall()).toEqual({
      url: "https://api.test/account/settings",
      method: "PATCH",
      body: { preferences: { uiLanguage: "fr" } },
    });
  });

  it("encodes the pairing request id in the path and the code in the query", async () => {
    fetchMock.mockImplementation(async () => Response.json({ ok: true, sessionId: "s1" }));
    await approvePairing("tkn", "req/1 x", { v: 1, epk: "e", iv: "i", ct: "c" }, "push-1");
    expect(await lastCall()).toEqual({
      url: "https://api.test/pairing/requests/req%2F1%20x/approve",
      method: "POST",
      body: { sealedKey: { v: 1, epk: "e", iv: "i", ct: "c" }, approverDeviceId: "push-1" },
    });
    await lookupPairing("tkn", "AB 12");
    expect(lastRequest().url).toBe("https://api.test/pairing/lookup?code=AB%2012");
  });

  it("reads library ops since a version and forwards the app scope", async () => {
    fetchMock.mockImplementation(async () => Response.json({}));
    await getLibraryOps("tkn", 7).catch(() => undefined);
    expect(lastRequest().url).toBe("https://api.test/library/db/ops?since=7");
    expect(lastRequest().headers.get("authorization")).toBe("Bearer tkn");
  });

  it("puts the library snapshot as JSON with the app scope given by the caller", async () => {
    fetchMock.mockImplementation(async () => Response.json({ version: 3, stateHash: null, lastOpId: null }));
    await putLibraryDb("tkn", 2, "bWFuaWZlc3Q=", "snap", 1024, null, false, null, null, "parrot", ["c1"]);
    expect(lastRequest().headers.get("x-space-app")).toBe("parrot");
    expect(lastRequest().headers.get("content-type")).toBe("application/json");
    expect(await lastCall()).toMatchObject({
      url: "https://api.test/library/db",
      method: "PUT",
      body: { expectedVersion: 2, manifest: "bWFuaWZlc3Q=", manifestEncoding: "base64", snapshotId: "snap", chunkRefs: ["c1"], force: false },
    });
  });

  it("appends a library op as an octet-stream body with the x-library headers", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ version: 4, snapshotVersion: 1, stateHash: "n", lastOpId: "op-1" })
    );
    const result = await putLibraryOp(
      "tkn",
      3,
      "op-1",
      new Uint8Array([1, 2, 3]),
      { prevStateHash: "p", nextStateHash: "n" },
      "parrot"
    );
    expect(result.version).toBe(4);
    const request = lastRequest();
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.test/library/db/ops");
    expect(request.headers.get("content-type")).toBe("application/octet-stream");
    expect(request.headers.get("authorization")).toBe("Bearer tkn");
    expect(request.headers.get("x-space-app")).toBe("parrot");
    expect(request.headers.get("x-library-base-version")).toBe("3");
    expect(request.headers.get("x-library-op-id")).toBe("op-1");
    expect(request.headers.get("x-library-prev-state-hash")).toBe("p");
    expect(request.headers.get("x-library-next-state-hash")).toBe("n");
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("sends an op's bytes without constructing a Blob (React Native's Blob rejects typed arrays)", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ version: 4, snapshotVersion: 1, stateHash: null, lastOpId: "op-1" })
    );
    const RealBlob = globalThis.Blob;
    class RnBlob {
      constructor() {
        throw new Error("Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported");
      }
    }
    vi.stubGlobal("Blob", RnBlob);
    try {
      await putLibraryOp("tkn", 3, "op-1", new Uint8Array([4, 5, 6]));
    } finally {
      vi.stubGlobal("Blob", RealBlob);
    }
    expect(new Uint8Array(await lastRequest().arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("omits the lineage headers of a library op when none is given", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ version: 4, snapshotVersion: 1, stateHash: null, lastOpId: "op-1" })
    );
    await putLibraryOp("tkn", 3, "op-1", new Uint8Array([9]));
    expect(lastRequest().headers.get("x-library-prev-state-hash")).toBeNull();
    expect(lastRequest().headers.get("x-library-next-state-hash")).toBeNull();
    expect(lastRequest().headers.get("x-space-app")).toBe("badger");
  });

  it("throws ApiError with the payload of a rejected library op", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: "version_conflict", version: 9 }, { status: 409 }));
    const error = await putLibraryOp("tkn", 3, "op-1", new Uint8Array([1])).catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, payload: { error: "version_conflict", version: 9 } });
  });
});
