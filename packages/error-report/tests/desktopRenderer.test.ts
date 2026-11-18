/**
 * REL-LOG-06: the app window starts its own error catcher only while the user's answer (kept by main)
 * is "on", loads the SDK adapter only then, and follows a change made in Settings or First setup live.
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import type { ErrorReporting } from "../src/controller";
import type { ErrorReportsState } from "../src/desktop";
import { createRendererErrorReports } from "../src/desktopRenderer";

const P = "[error-reports-renderer]";
const log = {
  info: (fields: Record<string, unknown>, msg: string) => console.info(`${P} log: ${msg} ${JSON.stringify(fields)}`),
  error: (fields: Record<string, unknown>, msg: string) => console.info(`${P} logError: ${msg} ${JSON.stringify(fields)}`),
};

type Decision = ErrorReportsState["decision"];

/** A bridge standing in for main: it keeps the answer the way the consent file does. */
const world = (initial: Decision, available = true) => {
  let decision = initial;
  const state = (): ErrorReportsState => ({ decision, available, release: "9.9.9" });
  const bridge = {
    get: vi.fn(async () => state()),
    set: vi.fn(async (next: "on" | "off") => {
      decision = next;
      return state();
    }),
  };
  const reporting: ErrorReporting & { setEnabled: Mock<(enabled: boolean) => Promise<void>> } = {
    isEnabled: () => reporting.setEnabled.mock.lastCall?.[0] === true,
    setEnabled: vi.fn(async (_enabled: boolean) => undefined),
  };
  const createReporting = vi.fn(async (release: string) => {
    console.info(`${P} adapter loaded for release ${release}`);
    return reporting;
  });
  const renderer = createRendererErrorReports({ bridge: () => bridge, createReporting, log });
  return { bridge, reporting, createReporting, renderer };
};

describe("@req REL-LOG-06[badger-desktop,parrot] the window loads nothing until the user opts in", () => {
  it.each<Decision>(["undecided", "off"])("a '%s' start never loads the SDK adapter", async (decision) => {
    const w = world(decision);
    await w.renderer.boot();
    expect(w.createReporting).not.toHaveBeenCalled();
    expect(w.reporting.setEnabled).not.toHaveBeenCalled();
  });

  it("an 'on' start loads the adapter for the app version and starts it", async () => {
    const w = world("on");
    const state = await w.renderer.boot();
    expect(state?.decision).toBe("on");
    expect(w.createReporting).toHaveBeenCalledWith("9.9.9");
    expect(w.reporting.setEnabled).toHaveBeenLastCalledWith(true);
  });

  it("a build without a reporting address never loads the adapter, even on 'on'", async () => {
    const w = world("on", false);
    await w.renderer.boot();
    await w.renderer.set("on");
    expect(w.createReporting).not.toHaveBeenCalled();
  });

  it("without a preload bridge (browser, tests) nothing happens", async () => {
    const createReporting = vi.fn();
    const renderer = createRendererErrorReports({ bridge: () => undefined, createReporting, log });
    expect(await renderer.boot()).toBeUndefined();
    expect(await renderer.get()).toBeUndefined();
    expect(await renderer.set("on")).toBeUndefined();
    expect(createReporting).not.toHaveBeenCalled();
  });
});

describe("@req REL-LOG-06[badger-desktop,parrot] a change made while the app runs takes effect live", () => {
  it("on starts reporting in this window, off stops it, on again restarts the same reporter", async () => {
    const w = world("off");
    await w.renderer.boot();
    expect(w.createReporting).not.toHaveBeenCalled();

    await w.renderer.set("on");
    expect(w.bridge.set).toHaveBeenLastCalledWith("on");
    expect(w.reporting.setEnabled).toHaveBeenLastCalledWith(true);

    await w.renderer.set("off");
    expect(w.bridge.set).toHaveBeenLastCalledWith("off");
    expect(w.reporting.setEnabled).toHaveBeenLastCalledWith(false);

    await w.renderer.set("on");
    console.info(`${P} adapter loads=${w.createReporting.mock.calls.length}`);
    expect(w.createReporting).toHaveBeenCalledTimes(1);
    expect(w.reporting.setEnabled).toHaveBeenLastCalledWith(true);
  });

  it("on then off before the adapter has finished loading ends off", async () => {
    let finishLoad: () => void = () => {};
    const w = world("off");
    const reporting = w.reporting;
    w.createReporting.mockImplementation(async (release: string) => {
      console.info(`${P} adapter import started for release ${release}, not finished yet`);
      await new Promise<void>((resolve) => (finishLoad = resolve));
      return reporting;
    });
    await w.renderer.boot();

    const on = w.renderer.set("on");
    await vi.waitFor(() => expect(w.createReporting).toHaveBeenCalledTimes(1));
    const off = w.renderer.set("off");
    // Let the "off" answer come back from main while the import is still pending.
    await vi.waitFor(() => expect(w.bridge.set).toHaveBeenLastCalledWith("off"));
    finishLoad();
    await Promise.all([on, off]);

    const calls = w.reporting.setEnabled.mock.calls.map(([enabled]) => enabled);
    console.info(`${P} setEnabled calls in order =`, calls);
    expect(calls.at(-1)).toBe(false);
    expect(w.reporting.isEnabled()).toBe(false);
  });

  it("an adapter that fails to load never breaks the answer: main stored it and the window keeps working", async () => {
    const bridge = { get: vi.fn(), set: vi.fn(async () => ({ decision: "on", available: true, release: "9.9.9" }) satisfies ErrorReportsState) };
    const renderer = createRendererErrorReports({ bridge: () => bridge, createReporting: async () => Promise.reject(new Error("chunk missing")), log });
    await expect(renderer.set("on")).resolves.toMatchObject({ decision: "on" });
  });
});
