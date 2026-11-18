/**
 * REL-LOG-06: every desktop app's (Badger, Parrot) error reports are opt-in. Main keeps the user's answer in
 * `<userData>/error-reports.json` and only starts the reporting SDK for "on". These tests run the real
 * consent file and the real opt-in gate of @space/error-report against a counting stand-in for the SDK,
 * with `fetch` and Electron's `net` replaced by spies to prove nothing touches the network before consent.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createConsentFile } from "../src/consentFile";
import { createErrorReporting } from "../src/controller";
import { ERROR_REPORTS_GET_CHANNEL, ERROR_REPORTS_SET_CHANNEL, parseForcedErrorReports, type ErrorReportsState } from "../src/desktop";
import { createErrorReports, registerErrorReportsIpc } from "../src/desktopMain";

const P = "[error-reports-main]";

const network = vi.hoisted(() => ({ netFetch: vi.fn(), netRequest: vi.fn() }));
vi.mock("electron", () => ({ net: { fetch: network.netFetch, request: network.netRequest } }));

let dir: string;
let consentPath: string;
let fetchSpy: Mock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sf-error-reports-main-"));
  consentPath = join(dir, "error-reports.json");
  fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
  console.info(`${P} userData=${dir}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh app start: a new consent-file instance, a new gate, a new SDK stand-in. */
const boot = (over: { available?: boolean; forced?: "off" | null } = {}) => {
  const sdk = { start: vi.fn(), stop: vi.fn() };
  const reporting = createErrorReporting(sdk);
  const controller = createErrorReports({
    consent: createConsentFile(consentPath),
    reporting,
    available: over.available ?? true,
    release: "9.9.9",
    forced: over.forced ?? null,
    log: (line) => console.info(`${P} log: ${line}`),
    logError: (line) => console.info(`${P} logError: ${line}`),
  });
  return { sdk, reporting, controller };
};

const expectQuietNetwork = () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(network.netFetch).not.toHaveBeenCalled();
  expect(network.netRequest).not.toHaveBeenCalled();
};

describe("@req REL-LOG-06[badger-desktop,parrot] error reports stay off until the user opts in", () => {
  it("a first start with no answer never starts the SDK, writes nothing and touches no network", async () => {
    const { sdk, controller } = boot();
    await controller.start();
    console.info(`${P} undecided state=${JSON.stringify(controller.getState())}`);
    expect(controller.getState()).toEqual({ decision: "undecided", available: true, release: "9.9.9" });
    expect(sdk.start).not.toHaveBeenCalled();
    expect(existsSync(consentPath)).toBe(false);
    expectQuietNetwork();
  });

  it("a stored 'off' never starts the SDK and touches no network", async () => {
    createConsentFile(consentPath).write("off");
    const { sdk, reporting, controller } = boot();
    await controller.start();
    expect(controller.getState().decision).toBe("off");
    expect(sdk.start).not.toHaveBeenCalled();
    expect(reporting.isEnabled()).toBe(false);
    expectQuietNetwork();
  });

  it("an unreadable or unrecognised answer file counts as undecided, never as consent", async () => {
    writeFileSync(consentPath, '{"version":1,"decision":"yes please"}');
    const { sdk, controller } = boot();
    await controller.start();
    expect(controller.getState().decision).toBe("undecided");
    expect(sdk.start).not.toHaveBeenCalled();
    writeFileSync(consentPath, "not json");
    expect(boot().controller.getState().decision).toBe("undecided");
  });
});

describe("@req REL-LOG-06[badger-desktop,parrot] the answer takes effect live and survives restarts", () => {
  it("opting in starts the SDK without a restart, opting out stops it", async () => {
    const { sdk, reporting, controller } = boot();
    await controller.start();
    expect(sdk.start).not.toHaveBeenCalled();

    const on = await controller.setDecision("on");
    console.info(`${P} after on: ${JSON.stringify(on)} start=${sdk.start.mock.calls.length}`);
    expect(on.decision).toBe("on");
    expect(sdk.start).toHaveBeenCalledTimes(1);
    expect(reporting.isEnabled()).toBe(true);

    const off = await controller.setDecision("off");
    console.info(`${P} after off: ${JSON.stringify(off)} stop=${sdk.stop.mock.calls.length}`);
    expect(off.decision).toBe("off");
    expect(sdk.stop).toHaveBeenCalledTimes(1);
    expect(reporting.isEnabled()).toBe(false);

    await controller.setDecision("on");
    expect(sdk.start).toHaveBeenCalledTimes(2);
  });

  it("the answer persists: a new start with a new consent file instance reads it", async () => {
    const first = boot();
    await first.controller.start();
    await first.controller.setDecision("on");
    expect(JSON.parse(readFileSync(consentPath, "utf8"))).toEqual({ version: 1, decision: "on" });

    const second = boot();
    await second.controller.start();
    console.info(`${P} restart state=${JSON.stringify(second.controller.getState())}`);
    expect(second.controller.getState().decision).toBe("on");
    expect(second.sdk.start).toHaveBeenCalledTimes(1);

    await second.controller.setDecision("off");
    const third = boot();
    await third.controller.start();
    expect(third.controller.getState().decision).toBe("off");
    expect(third.sdk.start).not.toHaveBeenCalled();
  });

  it("only 'on' and 'off' are accepted, and a refused answer leaves the file alone", async () => {
    const { sdk, controller } = boot();
    for (const bad of ["maybe", true, null, undefined, 1]) {
      await expect(controller.setDecision(bad)).rejects.toThrow(/invalid error-reports answer/);
    }
    expect(existsSync(consentPath)).toBe(false);
    expect(sdk.start).not.toHaveBeenCalled();
  });
});

describe("@req REL-LOG-06[badger-desktop,parrot] a build without a reporting address cannot report", () => {
  it("the answer can be stored but the SDK is never started and nothing is sent", async () => {
    createConsentFile(consentPath).write("on");
    const { sdk, reporting, controller } = boot({ available: false });
    await controller.start();
    expect(controller.getState()).toEqual({ decision: "on", available: false, release: "9.9.9" });
    await controller.setDecision("on");
    await controller.setDecision("off");
    await controller.setDecision("on");
    console.info(`${P} no-dsn start calls=${sdk.start.mock.calls.length}`);
    expect(sdk.start).not.toHaveBeenCalled();
    expect(reporting.isEnabled()).toBe(false);
    expectQuietNetwork();
  });
});

describe("@req REL-LOG-06[badger-desktop,parrot] SF_ERROR_REPORTS=off answers the question for a harness run", () => {
  it("only 'off' is understood", () => {
    expect(parseForcedErrorReports("off")).toBe("off");
    expect(parseForcedErrorReports(" OFF ")).toBe("off");
    expect(parseForcedErrorReports("on")).toBeNull();
    expect(parseForcedErrorReports(undefined)).toBeNull();
  });

  it("a forced run reads as answered 'off', never starts the SDK even over a stored 'on', and ignores answers", async () => {
    createConsentFile(consentPath).write("on");
    const { sdk, controller } = boot({ forced: "off" });
    await controller.start();
    expect(controller.getState().decision).toBe("off");
    expect(await controller.setDecision("on")).toMatchObject({ decision: "off" });
    expect(sdk.start).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(consentPath, "utf8")).decision).toBe("on");
    expectQuietNetwork();
  });
});

describe("@req REL-LOG-06[badger-desktop,parrot] the IPC handlers the preload bridge calls", () => {
  it("sf-error-reports-get / sf-error-reports-set read and store the answer", async () => {
    const handlers = new Map<string, (event: unknown, value?: unknown) => unknown>();
    const { sdk, controller } = boot();
    registerErrorReportsIpc({ handle: (channel, listener) => void handlers.set(channel, listener as never) }, controller);
    expect([...handlers.keys()].sort()).toEqual([ERROR_REPORTS_GET_CHANNEL, ERROR_REPORTS_SET_CHANNEL].sort());
    expect(ERROR_REPORTS_GET_CHANNEL).toBe("sf-error-reports-get");
    expect(ERROR_REPORTS_SET_CHANNEL).toBe("sf-error-reports-set");

    expect(handlers.get(ERROR_REPORTS_GET_CHANNEL)!({})).toMatchObject({ decision: "undecided", available: true });
    const stored = (await handlers.get(ERROR_REPORTS_SET_CHANNEL)!({}, "on")) as ErrorReportsState;
    expect(stored.decision).toBe("on");
    expect(sdk.start).toHaveBeenCalledTimes(1);
    expect(handlers.get(ERROR_REPORTS_GET_CHANNEL)!({})).toMatchObject({ decision: "on" });
    await expect(handlers.get(ERROR_REPORTS_SET_CHANNEL)!({}, { decision: "on" })).rejects.toThrow(/invalid/);
  });
});
