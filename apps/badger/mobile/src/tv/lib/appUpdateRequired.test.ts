/**
 * @test-id TV-APP-UPDATE-REQUIRED-001
 * @level unit
 *
 * @why REL-CD-29: the TV app states itself as a TV build (`badger/android-tv/<store version>`, its own minimum), and once
 *   the API refuses it as too old it shows the update screen instead of anything else, sign-in included.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => ({
  ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
  Platform: { OS: "android", isTV: true },
  NativeModules: { SpaceAppInfo: { appVersion: "0.2.0", installer: "com.android.vending" } },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { apiRequest, setApiBaseUrl } from "@space/shared/api";
import { __resetAppVersionStateForTests, getAppUpdateRequired, getClientIdentity } from "@space/shared/appVersion";
import "../../lib/apiConfig";
import { resolveNavigatorScreen } from "../../navigation/resolveScreen";

const log = (testId: string, phase: string, data?: unknown) =>
  console.info(`[tv-app-update-required] ${testId} ${phase}`, data === undefined ? "" : JSON.stringify(data));

afterEach(() => {
  vi.unstubAllGlobals();
  setApiBaseUrl("/api");
});

// @req REL-CD-29[badger-tv]
describe("TV app and the version gate", () => {
  it("states itself as an Android TV build and sends it on API calls", async () => {
    const id = "TV-IDENTITY";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setApiBaseUrl("http://api.test");
    await apiRequest("/x");
    const header = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers).get("x-space-client");
    log(id, "phase:identity", { identity: getClientIdentity(), header });
    expect(getClientIdentity()).toEqual({ app: "badger", platform: "android-tv", version: "0.2.0+play" });
    expect(header).toBe("badger/android-tv/0.2.0+play");
  });

  it("shows the update screen once refused, before sign-in", async () => {
    const id = "TV-REFUSED";
    const refusal = { error: "app_update_required", app: "badger", platform: "android-tv", version: "0.2.0", minVersion: "0.3.0" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(refusal), { status: 426 })));
    setApiBaseUrl("http://api.test");
    await apiRequest("/auth/pair/start", { method: "POST" }).catch(() => undefined);
    const screen = resolveNavigatorScreen({
      updateRequired: getAppUpdateRequired() !== null,
      authLoading: false,
      user: null,
      contractIssue: null,
      formatTooNew: false,
      needsKey: false,
      errorReportsAnswered: true,
      initializing: false,
      datasetStatus: { core: true },
    });
    log(id, "phase:after-refusal", { latched: getAppUpdateRequired(), screen });
    expect(getAppUpdateRequired()).toEqual(refusal);
    expect(screen).toBe("contract-error");
    __resetAppVersionStateForTests();
  });
});
