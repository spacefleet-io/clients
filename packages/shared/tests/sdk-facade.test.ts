import { ApiError as SdkApiError } from "@space/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiRequest,
  deleteAccount,
  getAccountStorage,
  getMe,
  getSettings,
  listDevices,
  login,
  revokeDevice,
  sendFeedback,
  setApiBaseUrl,
} from "../src/api";

// The first-party apps (Badger desktop/mobile/TV) call the account API through
// `@space/shared/api`; DEV-API-02 requires that facade to be the generated SDK.

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const lastRequest = () => (fetchMock.mock.calls.at(-1) as [Request])[0];

beforeEach(() => {
  setApiBaseUrl("https://api.test/api");
});

afterEach(() => {
  fetchMock.mockReset();
  setApiBaseUrl("/api");
});

describe("@space/shared/api account calls reach the SDK client", () => {
  it("sendFeedback posts with the token, scoped to the sending app (Badger by default)", async () => {
    fetchMock.mockImplementation(async () => Response.json({ id: "f1" }, { status: 201 }));
    const body = { message: "hi", app: "parrot-desktop" as const };
    expect(await sendFeedback("tok", body, "parrot")).toEqual({ id: "f1" });
    expect(lastRequest().url).toBe("https://api.test/api/feedback");
    expect(lastRequest().headers.get("authorization")).toBe("Bearer tok");
    expect(lastRequest().headers.get("x-space-app")).toBe("parrot");

    await sendFeedback("tok", { ...body, app: "badger-mobile" });
    expect(lastRequest().headers.get("x-space-app")).toBe("badger");
  });

  /** @req DEV-API-02[badger-desktop,badger-mobile,badger-tv] */
  it("login is the SDK's POST /auth/login, built as a Request with the app scope", async () => {
    fetchMock.mockImplementation(async () => Response.json({ token: "t", user: { id: "u1" } }));
    const session = await login("a@b.c", "pw");
    expect(session.token).toBe("t");
    const request = lastRequest();
    expect(request).toBeInstanceOf(Request);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.test/api/auth/login");
    expect(request.headers.get("x-space-app")).toBe("badger");
    expect(request.headers.get("authorization")).toBeNull();
  });

  /** @req DEV-API-02[badger-desktop,badger-mobile,badger-tv] */
  it("getMe and getSettings send GET with the bearer token and the app scope", async () => {
    fetchMock.mockImplementation(async () => Response.json({ user: {} }));
    await getMe("tkn");
    expect(fetchMock).toHaveBeenLastCalledWith(expect.any(Request));
    expect(lastRequest().method).toBe("GET");
    expect(lastRequest().url).toBe("https://api.test/api/auth/me");
    expect(lastRequest().headers.get("authorization")).toBe("Bearer tkn");
    expect(lastRequest().headers.get("x-space-app")).toBe("badger");

    fetchMock.mockImplementation(async () => Response.json({ email: "a@b.c" }));
    await getSettings("tkn");
    expect(lastRequest().url).toBe("https://api.test/api/account/settings");
    expect(lastRequest().headers.get("authorization")).toBe("Bearer tkn");
  });

  /** @req DEV-API-02[badger-desktop,badger-mobile,badger-tv] */
  it("listDevices and revokeDevice hit /devices and /devices/revoke", async () => {
    fetchMock.mockImplementation(async () => Response.json({ sessions: [] }));
    await expect(listDevices("tkn")).resolves.toEqual({ sessions: [] });
    expect(lastRequest()).toBeInstanceOf(Request);
    expect(lastRequest().method).toBe("GET");
    expect(lastRequest().url).toBe("https://api.test/api/devices");

    fetchMock.mockImplementation(async () => Response.json({ ok: true }));
    await revokeDevice("tkn", "session-1");
    expect(lastRequest().method).toBe("POST");
    expect(lastRequest().url).toBe("https://api.test/api/devices/revoke");
    expect(lastRequest().headers.get("authorization")).toBe("Bearer tkn");
    expect(await lastRequest().json()).toEqual({ sessionId: "session-1" });
  });

  /** @req DEV-API-02[badger-desktop,badger-mobile,badger-tv] */
  it("getAccountStorage reads GET /account/storage", async () => {
    const summary = {
      plan: "free",
      storageAddonCount: 0,
      limitBytes: 10,
      usedBytes: 1,
      reservedBytes: 0,
      usageRatio: 0.1,
      warningLevel: "ok",
      apps: [],
      lastReconciledAt: null,
    };
    fetchMock.mockImplementation(async () => Response.json(summary));
    await expect(getAccountStorage("tkn")).resolves.toEqual(summary);
    expect(lastRequest()).toBeInstanceOf(Request);
    expect(lastRequest().url).toBe("https://api.test/api/account/storage");
    expect(lastRequest().headers.get("x-space-app")).toBe("badger");
  });

  /** @req DEV-API-02[badger-desktop,badger-mobile,badger-tv] */
  it("deleteAccount is the SDK's DELETE /account with a JSON body", async () => {
    fetchMock.mockImplementation(async () => Response.json({ status: "deletion_scheduled" }, { status: 202 }));
    await deleteAccount("tkn", { password: "pw", confirm: "DELETE" });
    expect(lastRequest()).toBeInstanceOf(Request);
    expect(lastRequest().method).toBe("DELETE");
    expect(lastRequest().url).toBe("https://api.test/api/account");
    expect(await lastRequest().json()).toEqual({ password: "pw", confirm: "DELETE" });
  });

  /** @req DEV-API-02[badger-desktop,badger-mobile,badger-tv] */
  it("follows setApiBaseUrl: the one SDK client is re-pointed, not recreated per call", async () => {
    fetchMock.mockImplementation(async () => Response.json({ sessions: [] }));
    await listDevices("tkn");
    expect(lastRequest().url).toBe("https://api.test/api/devices");
    setApiBaseUrl("https://other.test/");
    await listDevices("tkn");
    expect(lastRequest().url).toBe("https://other.test/devices");
  });
});

describe("@space/shared/api errors", () => {
  /** @req DEV-API-02[badger-desktop,badger-mobile,badger-tv] */
  it("ApiError is the very class of @space/sdk", () => {
    expect(ApiError).toBe(SdkApiError);
  });

  /** @req DEV-API-02[badger-desktop,badger-mobile,badger-tv] */
  it("a failed SDK-backed call throws an error that is instanceof both exports", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: "unauthorized" }, { status: 401 }));
    const error = await getMe("bad").catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(SdkApiError);
    expect(error).toMatchObject({ status: 401, message: "unauthorized", payload: { error: "unauthorized" } });
  });

  /** @req DEV-API-02[badger-desktop,badger-mobile,badger-tv] */
  it("the hand-written apiRequest (admin routes) throws the same class", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: "forbidden" }, { status: 403 }));
    const error = await apiRequest("/admin/overview", { token: "tkn" }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SdkApiError);
    expect((error as SdkApiError).status).toBe(403);
  });
});
