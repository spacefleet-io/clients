/**
 * @test-id MOBILE-APP-UPDATE-REQUIRED-001
 * @level unit
 *
 * @why REL-CD-29: the phone app states its app, platform and store version on every API call, and once the API refuses
 *   it as too old (426 app_update_required, from any call, sign-in included) it shows the update screen instead of
 *   anything else.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Platform: { OS: "android", isTV: false },
  NativeModules: { SpaceAppInfo: { appVersion: "0.3.1", installer: "com.android.vending" } },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { ApiError, apiRequest, setApiBaseUrl } from "@space/shared/api";
import {
  __resetAppVersionStateForTests,
  getAppUpdateRequired,
  getClientIdentity,
  onAppUpdateRequired,
} from "@space/shared/appVersion";
import "../src/lib/apiConfig";
import { resolveNavigatorScreen } from "../src/navigation/resolveScreen";

const SUITE = "app-update-required";
const log = (testId: string, phase: string, data?: unknown) =>
  console.info(`[${SUITE}] ${testId} ${phase}`, data === undefined ? "" : JSON.stringify(data));

const refusal = { error: "app_update_required", app: "badger", platform: "android", version: "0.3.1", minVersion: "0.4.0" };

const signedOutInput = {
  authLoading: false,
  user: null,
  contractIssue: null,
  formatTooNew: false,
  needsKey: false,
  errorReportsAnswered: true,
  initializing: false,
  datasetStatus: { core: true },
};

afterEach(() => {
  vi.unstubAllGlobals();
  setApiBaseUrl("/api");
});

// @req REL-CD-29[badger-mobile]
describe("phone app states its version", () => {
  it("states badger/android/<store version>+<install source> from module load", () => {
    const id = "MOB-IDENTITY";
    const identity = getClientIdentity();
    log(id, "phase:identity", identity);
    expect(identity).toEqual({ app: "badger", platform: "android", version: "0.3.1+play" });
  });

  it("sends the header on API calls", async () => {
    const id = "MOB-HEADER";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setApiBaseUrl("http://api.test");
    await apiRequest("/x");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const header = new Headers(init?.headers).get("x-space-client");
    log(id, "phase:header", header);
    expect(header).toBe("badger/android/0.3.1+play");
  });
});

// @req REL-CD-29[badger-mobile]
describe("phone app shows the update screen once refused", () => {
  it("shows the update screen over sign-in, loading and the library", () => {
    const id = "MOB-SCREEN";
    const screens = {
      signedOut: resolveNavigatorScreen({ ...signedOutInput, updateRequired: true }),
      authLoading: resolveNavigatorScreen({ ...signedOutInput, authLoading: true, updateRequired: true }),
      signedIn: resolveNavigatorScreen({ ...signedOutInput, user: { id: "u" }, updateRequired: true }),
      notRefused: resolveNavigatorScreen({ ...signedOutInput, updateRequired: false }),
    };
    log(id, "phase:screens", screens);
    expect(screens).toEqual({
      signedOut: "contract-error",
      authLoading: "contract-error",
      signedIn: "contract-error",
      notRefused: "auth",
    });
  });

  it("latches the refusal from any call and tells the navigator", async () => {
    const id = "MOB-LATCH";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(refusal), { status: 426 })));
    setApiBaseUrl("http://api.test");
    const heard: unknown[] = [];
    const unsubscribe = onAppUpdateRequired((payload) => heard.push(payload));
    const error = await apiRequest("/auth/login", { method: "POST" }).catch((e: unknown) => e);
    unsubscribe();
    log(id, "phase:after-refusal", { heard, latched: getAppUpdateRequired(), error: String(error) });
    expect(error).toBeInstanceOf(ApiError);
    expect(heard).toEqual([refusal]);
    expect(getAppUpdateRequired()).toEqual(refusal);
    __resetAppVersionStateForTests();
  });
});
