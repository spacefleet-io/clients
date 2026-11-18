/**
 * @test-id error-report-controller
 * @level unit
 */
import { describe, expect, it } from "vitest";
import { createErrorReporting } from "../src";

const APPS = "[badger-desktop,badger-mobile]";

function fakeSdk() {
  const calls: string[] = [];
  return {
    calls,
    sdk: {
      async start() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        calls.push("start");
      },
      stop() {
        calls.push("stop");
      },
    },
  };
}

describe("error reporting controller", () => {
  // @req REL-LOG-06[badger-desktop,badger-mobile]
  it(`@req REL-LOG-06${APPS} starts nothing until the user opts in`, async () => {
    const { calls, sdk } = fakeSdk();
    const reporting = createErrorReporting(sdk);

    await reporting.setEnabled(false);

    expect(calls).toEqual([]);
    expect(reporting.isEnabled()).toBe(false);
  });

  // @req REL-LOG-06[badger-desktop,badger-mobile]
  it(`@req REL-LOG-06${APPS} starts once on opt-in and stops on opt-out`, async () => {
    const { calls, sdk } = fakeSdk();
    const reporting = createErrorReporting(sdk);

    await reporting.setEnabled(true);
    await reporting.setEnabled(true);
    await reporting.setEnabled(false);
    await reporting.setEnabled(false);

    expect(calls).toEqual(["start", "stop"]);
  });

  it("applies rapid changes in order", async () => {
    const { calls, sdk } = fakeSdk();
    const reporting = createErrorReporting(sdk);

    void reporting.setEnabled(true);
    void reporting.setEnabled(false);
    await reporting.setEnabled(true);

    expect(calls).toEqual(["start", "stop", "start"]);
    expect(reporting.isEnabled()).toBe(true);
  });
});

describe("a failing SDK", () => {
  // @req REL-LOG-06[badger-desktop,badger-mobile]
  it("@req REL-LOG-06[badger-desktop,badger-mobile] lets the user turn reporting off after a failed start", async () => {
    let failStart = true;
    const stops: number[] = [];
    const reporting = createErrorReporting({
      start() {
        if (failStart) throw new Error("boom");
      },
      stop() {
        stops.push(1);
      },
    });
    await expect(reporting.setEnabled(true)).rejects.toThrow("boom");
    expect(reporting.isEnabled()).toBe(false);
    failStart = false;
    await reporting.setEnabled(true);
    await reporting.setEnabled(false);
    console.info("[controller-test] stops after recovery =", stops.length);
    expect(stops).toHaveLength(1);
  });
});
