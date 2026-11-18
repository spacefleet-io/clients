/**
 * @test-id MOBILE-PULL-REFRESH-RELEASE-GATE-001
 * @level unit
 * @bugfix
 * @regression-proof
 * @req UX-REFRESH-01
 *
 * Why this exists: on iOS the native refresh control fires as soon as the pull
 * crosses its threshold, while the finger is still on the screen, so the page
 * refreshed before the user let go. The refresh must wait for the release.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

// Dynamic import: the module must load after the react-native mock above is registered.
const { createPullReleaseGate } = await import("../src/lib/usePullToRefresh");

describe("pull to refresh waits for the finger to lift", () => {
  it("@bugfix @regression-proof a trigger during the drag fires only on release, once", () => {
    const fire = vi.fn();
    const gate = createPullReleaseGate(fire);

    gate.beginDrag();
    expect(gate.trigger(), "threshold crossed with the finger down").toBe(false);
    gate.trigger();
    console.info("[pull-refresh-gate] fired while dragging:", fire.mock.calls.length);
    expect(fire, "nothing refreshes while the finger is down").not.toHaveBeenCalled();

    gate.endDrag();
    console.info("[pull-refresh-gate] fired after release:", fire.mock.calls.length);
    expect(fire, "release starts exactly one refresh").toHaveBeenCalledTimes(1);

    gate.beginDrag();
    gate.endDrag();
    expect(fire, "a later drag that never crossed the threshold does not refresh").toHaveBeenCalledTimes(1);
  });

  it("a trigger outside a drag (Android, programmatic) fires at once", () => {
    const fire = vi.fn();
    const gate = createPullReleaseGate(fire);
    expect(gate.trigger()).toBe(true);
    expect(fire).toHaveBeenCalledTimes(1);
  });
});
