/**
 * @test-id TV-MENUKEY-001
 * @level unit
 * @req UX-TV-01[badger-tv]
 * @why On tvOS the Menu key reaches JavaScript only while it is enabled, and an enabled key nobody consumes does nothing:
 * it must be on exactly while some screen can go back (so Back works in details / player / dialogs) and off on the first
 * screen (so Menu there returns to the Apple TV home screen, as tvOS apps do).
 */
import { describe, expect, it, vi } from "vitest";
import { createMenuKeyHolds, stackHasScreenToPop } from "./menuKey";

const setup = () => {
  const control = { enable: vi.fn(), disable: vi.fn() };
  const events: Array<[string, Record<string, unknown>]> = [];
  const holds = createMenuKeyHolds(control, (event, payload) => {
    events.push([event, payload]);
    console.info(`[tv-menukey:${event}]`, JSON.stringify(payload));
  });
  return { control, holds, events };
};

describe("tv menu key holds", () => {
  it("starts off: Menu on the first screen is the system's (back to the Apple TV home screen)", () => {
    const { control, holds } = setup();
    expect(holds.enabled()).toBe(false);
    expect(control.enable).not.toHaveBeenCalled();
    expect(control.disable).not.toHaveBeenCalled();
  });

  it("turns on with the first hold and off with the last release", () => {
    const { control, holds } = setup();
    holds.set("stack", true);
    expect(holds.enabled()).toBe(true);
    expect(control.enable).toHaveBeenCalledTimes(1);
    holds.set("tab", true);
    expect(control.enable).toHaveBeenCalledTimes(1);
    holds.set("stack", false);
    expect(holds.enabled()).toBe(true);
    expect(control.disable).not.toHaveBeenCalled();
    holds.set("tab", false);
    expect(holds.enabled()).toBe(false);
    expect(control.disable).toHaveBeenCalledTimes(1);
    expect(holds.reasons()).toEqual([]);
  });

  it("is idempotent per reason", () => {
    const { control, holds, events } = setup();
    holds.set("stack", true);
    holds.set("stack", true);
    holds.set("other", false);
    expect(control.enable).toHaveBeenCalledTimes(1);
    expect(control.disable).not.toHaveBeenCalled();
    expect(holds.reasons()).toEqual(["stack"]);
    expect(events.filter(([e]) => e === "tv.menuKey.hold")).toHaveLength(1);
  });

  it("logs every change with the reasons that hold the key", () => {
    const { holds, events } = setup();
    holds.set("b", true);
    holds.set("a", true);
    holds.set("b", false);
    expect(events.filter(([e]) => e === "tv.menuKey.hold").map(([, p]) => p)).toEqual([
      { reason: "b", active: true, holds: ["b"], enabled: true },
      { reason: "a", active: true, holds: ["a", "b"], enabled: true },
      { reason: "b", active: false, holds: ["a"], enabled: true },
    ]);
  });
});

describe("stack hold", () => {
  it.each([
    [0, false],
    [1, false],
    [2, true],
    [3, true],
  ])("%i route(s) in the root stack -> Menu pops: %s", (routes, expected) => {
    expect(stackHasScreenToPop(routes)).toBe(expected);
  });
});
