/**
 * @test-id SHARED-APP-VERSION-001
 * @level unit
 *
 * @why REL-CD-29: every app says its app, platform and version on every API call (SDK calls and hand-written
 *   fetches alike), and the first "please update" refusal of any call is latched for the app's update screen.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest, getMe, putLibraryDbBinary, setApiBaseUrl } from "../src/api";
import {
  __resetAppVersionStateForTests,
  appUpdateRequiredFrom,
  clientIdentityHeaders,
  compareVersions,
  formatClientHeader,
  getAppUpdateRequired,
  isLibraryOpStreamSwitch,
  onAppUpdateRequired,
  parseClientHeader,
  setClientIdentity,
  requireLibraryUpdate,
  setLibraryReadOpStreamVersion,
  webClientIdentity,
} from "../src/appVersion";
import { WEB_UPDATE_COPY, webUpdateCopyFor } from "../src/webUpdate";

const SUITE = "app-version";
const log = (testId: string, phase: string, data?: unknown) =>
  console.info(`[${SUITE}] ${testId} ${phase}`, data === undefined ? "" : JSON.stringify(data));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const headerOf = (call: unknown[]): string | null => {
  const [input, init] = call;
  if (input instanceof Request) return input.headers.get("x-space-client");
  return new Headers((init as RequestInit | undefined)?.headers).get("x-space-client");
};

const refusal = {
  error: "app_update_required",
  app: "badger",
  platform: "android",
  version: "0.2.0",
  minVersion: "0.3.0",
};

afterEach(() => {
  fetchMock.mockReset();
  setApiBaseUrl("/api");
  __resetAppVersionStateForTests();
});

describe("client identity header", () => {
  it("formats and parses app/platform/version @req REL-CD-29", () => {
    const id = "HEADER-PARSE";
    const header = formatClientHeader({ app: "badger", platform: "android-tv", version: "1.2.3" });
    const parsed = {
      header,
      ok: parseClientHeader(header),
      upper: parseClientHeader("Badger/iOS/2.0.0-beta.1"),
      missing: parseClientHeader(undefined),
      tooMany: parseClientHeader("badger/android/1.0.0/x"),
      badApp: parseClientHeader("nope/android/1.0.0"),
      badPlatform: parseClientHeader("badger/amiga/1.0.0"),
      badVersion: parseClientHeader("badger/android/latest"),
    };
    log(id, "phase:parsed", parsed);
    expect(header).toBe("badger/android-tv/1.2.3");
    expect(parsed.ok).toEqual({ app: "badger", platform: "android-tv", version: "1.2.3" });
    expect(parsed.upper).toEqual({ app: "badger", platform: "ios", version: "2.0.0-beta.1" });
    expect([parsed.missing, parsed.tooMany, parsed.badApp, parsed.badPlatform, parsed.badVersion]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("compares versions numerically @req REL-CD-29", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.2.3-beta", "1.2.3")).toBe(0);
    expect(compareVersions("0.2.9", "0.3.0")).toBe(-1);
  });

  it("is sent on SDK calls and hand-written fetches once set, and not before @req REL-CD-29", async () => {
    const id = "HEADER-SENT";
    setApiBaseUrl("http://api.test");
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ user: null }), { status: 200 }));

    await getMe("t").catch(() => undefined);
    await apiRequest("/x").catch(() => undefined);
    const before = fetchMock.mock.calls.map(headerOf);
    log(id, "phase:before-identity", before);
    expect(before).toEqual([null, null]);
    expect(clientIdentityHeaders()).toEqual({});

    fetchMock.mockClear();
    setClientIdentity({ app: "badger", platform: "desktop", version: "0.4.0" });
    await getMe("t").catch(() => undefined);
    await apiRequest("/x").catch(() => undefined);
    await putLibraryDbBinary("t", 1, new Uint8Array([1]), "snap-1", 1024).catch(() => undefined);
    const after = fetchMock.mock.calls.map(headerOf);
    log(id, "phase:after-identity", after);
    expect(after).toEqual(["badger/desktop/0.4.0", "badger/desktop/0.4.0", "badger/desktop/0.4.0"]);
    expect(clientIdentityHeaders()).toEqual({ "x-space-client": "badger/desktop/0.4.0" });
  });
});

describe("update refusal", () => {
  it("latches the first refusal of any call and tells listeners once @req REL-CD-29", async () => {
    const id = "REFUSAL-LATCH";
    setApiBaseUrl("http://api.test");
    const seen: unknown[] = [];
    onAppUpdateRequired((payload) => seen.push(payload));
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(refusal), { status: 426 }));

    const first = await getMe("t").catch((error: unknown) => error);
    await apiRequest("/x").catch(() => undefined);
    log(id, "phase:after-refusals", { seen, latched: getAppUpdateRequired(), first: String(first) });
    expect(first).toBeInstanceOf(ApiError);
    expect(appUpdateRequiredFrom(first)).toEqual(refusal);
    expect(getAppUpdateRequired()).toEqual(refusal);
    expect(seen).toEqual([refusal]);

    // A listener that subscribes later hears it at once.
    const late: unknown[] = [];
    onAppUpdateRequired((payload) => late.push(payload));
    expect(late).toEqual([refusal]);
  });

  it("ignores other errors, including other 426 bodies @req REL-CD-29", () => {
    const id = "REFUSAL-OTHER";
    const errors = [new ApiError(401, { error: "unauthorized" }), new ApiError(426, { error: "something_else" })];
    log(id, "phase:errors", errors.map((e) => [e.status, e.payload]));
    expect(errors.map(appUpdateRequiredFrom)).toEqual([null, null]);
    expect(getAppUpdateRequired()).toBeNull();
  });
});

describe("library op stream switch (LIB-FMT-13)", () => {
  const switchRefusal = { ...refusal, reason: "library_op_stream", opStreamVersion: 4 };

  it("does not latch a switch this build reads; the writer retries instead @req REL-CD-29", async () => {
    const id = "OP-STREAM-SWITCH-READ";
    setApiBaseUrl("http://api.test");
    setLibraryReadOpStreamVersion(4);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(switchRefusal), { status: 426 }));
    const error = await apiRequest("/library/db/ops").catch((caught: unknown) => caught);
    log(id, "phase:refused", { error: String(error), switch: isLibraryOpStreamSwitch(error), latched: getAppUpdateRequired() });
    expect(error).toBeInstanceOf(ApiError);
    expect(isLibraryOpStreamSwitch(error)).toBe(true);
    expect(getAppUpdateRequired()).toBeNull();
  });

  it("latches it for a build that reads an older op stream or never said @req REL-CD-29", async () => {
    const id = "OP-STREAM-SWITCH-OLD";
    setApiBaseUrl("http://api.test");
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(switchRefusal), { status: 426 }));
    const unset = await apiRequest("/library/db/ops").catch((caught: unknown) => caught);
    const unsetLatched = getAppUpdateRequired();
    __resetAppVersionStateForTests();
    setLibraryReadOpStreamVersion(3);
    const older = await apiRequest("/library/db/ops").catch((caught: unknown) => caught);
    log(id, "phase:refused", {
      unsetSwitch: isLibraryOpStreamSwitch(unset),
      unsetLatched,
      olderSwitch: isLibraryOpStreamSwitch(older),
      olderLatched: getAppUpdateRequired(),
    });
    expect(isLibraryOpStreamSwitch(unset)).toBe(false);
    expect(unsetLatched).toEqual(refusal);
    expect(isLibraryOpStreamSwitch(older)).toBe(false);
    expect(getAppUpdateRequired()).toEqual(refusal);
    expect(isLibraryOpStreamSwitch(new ApiError(426, refusal))).toBe(false);
  });

  it("latches an op type this build does not know into the same state, once @req LIB-FMT-13[badger-mobile] @req LIB-FMT-13[badger-tv]", () => {
    const id = "LIBRARY-UPDATE-LATCH";
    setClientIdentity({ app: "badger", platform: "android", version: "0.4.0" });
    const seen: unknown[] = [];
    onAppUpdateRequired((payload) => seen.push(payload));
    requireLibraryUpdate();
    requireLibraryUpdate();
    // A 426 after it (same latch as the API hook) changes nothing either: one source of truth, first payload wins.
    void new ApiError(426, refusal);
    const expected = {
      error: "app_update_required",
      app: "badger",
      platform: "android",
      version: "0.4.0",
      minVersion: "",
      reason: "library_op_stream",
    };
    log(id, "phase:latched", { seen, latched: getAppUpdateRequired() });
    expect(getAppUpdateRequired()).toEqual(expected);
    expect(seen).toEqual([expected]);

    // The API's refusal fills the same latch: a later requireLibraryUpdate keeps it.
    __resetAppVersionStateForTests();
    void new ApiError(426, refusal);
    requireLibraryUpdate("library_schema");
    expect(getAppUpdateRequired()).toEqual(refusal);
  });
});

describe("library format refusal", () => {
  // LIB-FMT-05 / LIB-FMT-09: a save declaring an older library format than the account holds is refused with 409
  // `library_format_downgrade`. That build can never save this library again, so it is the same "please update" as a
  // 426: the first one latches for the update screen (Parrot desktop) or the reload notice (the web players).
  const formatRefusal = { error: "library_format_downgrade", surface: "op-stream", observed: 2, stored: 4 };

  it("latches a format refusal as update required, stating this build @req LIB-FMT-09[parrot] @bugfix @regression-proof", async () => {
    const id = "FORMAT-REFUSAL-LATCH";
    setApiBaseUrl("http://api.test");
    setClientIdentity({ app: "parrot", platform: "desktop", version: "0.5.0" });
    const seen: unknown[] = [];
    onAppUpdateRequired((payload) => seen.push(payload));
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(formatRefusal), { status: 409 }));

    const error = await putLibraryDbBinary("t", 7, new Uint8Array([1]), "snap-1", 1024).catch((e: unknown) => e);
    log(id, "phase:refused", { error: String(error), status: (error as ApiError).status, latched: getAppUpdateRequired(), seen });
    expect(error).toBeInstanceOf(ApiError);
    const expected = { error: "app_update_required", app: "parrot", platform: "desktop", version: "0.5.0", minVersion: "" };
    expect(appUpdateRequiredFrom(error)).toEqual(expected);
    expect(getAppUpdateRequired()).toEqual(expected);
    expect(seen).toEqual([expected]);
  });

  it("latches it for a web player too @req LIB-FMT-09[parrot-web-player] @bugfix @regression-proof", () => {
    const id = "FORMAT-REFUSAL-WEB";
    setClientIdentity(webClientIdentity("parrot", "2026.1118.1915"));
    const error = new ApiError(409, formatRefusal);
    log(id, "phase:refused", { latched: getAppUpdateRequired() });
    expect(getAppUpdateRequired()).toEqual({
      error: "app_update_required",
      app: "parrot",
      platform: "web",
      version: "2026.1118.1915",
      minVersion: "",
    });
    expect(appUpdateRequiredFrom(error)?.platform).toBe("web");
  });

  it("does not latch a plain version conflict, or the downgrade code on another status @req LIB-FMT-09[parrot]", () => {
    const id = "FORMAT-REFUSAL-OTHER";
    setClientIdentity({ app: "parrot", platform: "desktop", version: "0.5.0" });
    const errors = [
      new ApiError(409, { error: "version_conflict" }),
      new ApiError(409, {}),
      new ApiError(400, { error: "library_format_downgrade" }),
    ];
    log(id, "phase:errors", errors.map((e) => [e.status, e.payload, appUpdateRequiredFrom(e)]));
    expect(errors.map(appUpdateRequiredFrom)).toEqual([null, null, null]);
    expect(getAppUpdateRequired()).toBeNull();
  });
});

describe("web players", () => {
  it("state the website build's version, and nothing without one @req REL-CD-29[badger-web-player] @req REL-CD-29[parrot-web-player]", () => {
    const id = "WEB-IDENTITY";
    const seen = {
      badger: webClientIdentity("badger", "2026.1118.1915"),
      parrot: webClientIdentity("parrot", " 2026.0105.0905 "),
      dev: webClientIdentity("badger", undefined),
      empty: webClientIdentity("parrot", ""),
      malformed: webClientIdentity("badger", "main-566e68c"),
    };
    log(id, "phase:identities", seen);
    expect(seen.badger).toEqual({ app: "badger", platform: "web", version: "2026.1118.1915" });
    expect(seen.parrot).toEqual({ app: "parrot", platform: "web", version: "2026.0105.0905" });
    expect([seen.dev, seen.empty, seen.malformed]).toEqual([null, null, null]);
    expect(parseClientHeader(formatClientHeader(seen.badger!))).toEqual(seen.badger);
    // Built later = a higher version, across a month and a year boundary.
    expect(compareVersions("2026.1118.1915", "2026.1118.0905")).toBe(1);
    expect(compareVersions("2026.1201.0000", "2026.1130.2359")).toBe(1);
    expect(compareVersions("2027.0101.0000", "2026.1231.2359")).toBe(1);
  });

  it("have the reload notice in the five client languages @req REL-CD-29[badger-web-player]", () => {
    const id = "WEB-COPY";
    log(id, "phase:copy", WEB_UPDATE_COPY);
    expect(WEB_UPDATE_COPY.en).toEqual({ title: "SpaceFleet has been updated. Reload to continue", reload: "Reload" });
    for (const copy of Object.values(WEB_UPDATE_COPY)) {
      expect(Object.keys(copy).sort()).toEqual(["reload", "title"]);
      expect(copy.title).toContain("SpaceFleet");
      expect(copy.reload.length).toBeGreaterThan(0);
    }
    expect(webUpdateCopyFor("fr-FR")).toBe(WEB_UPDATE_COPY.fr);
    expect(webUpdateCopyFor("pt")).toBe(WEB_UPDATE_COPY.en);
  });
});
