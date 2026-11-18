// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-NEWS-OPT-IN-001
 * @level unit (real hook, real React; the bridge is a fake)
 * @req ACCT-NEWS-01
 * @why The settings switch for News emails reads the account's opt-in through main and saves it there. Without a
 *   bridge the row is hidden; while the value is unread, or unreadable, the switch stays disabled rather than guess.
 */
import React, { act } from "react";
import { setTimeout as tick } from "node:timers/promises";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParrotBridge } from "../src/shared/ipc";
import { useNewsOptIn, type NewsOptInSwitch } from "../src/renderer/src/newsOptIn";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type NewsBridge = Pick<ParrotBridge, "getNewsOptIn" | "saveNewsOptIn">;
type Hook = NewsOptInSwitch;

let root: Root | null = null;
let latest: Hook | null = null;

function Probe({ bridge }: { bridge: NewsBridge | undefined }) {
  latest = useNewsOptIn(bridge);
  return null;
}

const mount = async (bridge: NewsBridge | undefined) => {
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Probe bridge={bridge} />));
  await act(async () => {
    for (let i = 0; i < 3; i += 1) await tick(0);
  });
};

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  latest = null;
});

describe("ACCT-NEWS-01 Parrot desktop: the News opt-in switch", () => {
  // @req ACCT-NEWS-01[parrot]
  it("reads the account's opt-in and saves the switch through main", async () => {
    const saveNewsOptIn = vi.fn(async (on: boolean) => ({ ok: true as const, newsOptIn: on }));
    await mount({ getNewsOptIn: async () => ({ ok: true, newsOptIn: false }), saveNewsOptIn });
    expect(latest?.value).toBe(false);

    await act(async () => latest!.set(true));
    expect(saveNewsOptIn).toHaveBeenCalledWith(true);
    expect(latest?.value).toBe(true);
    expect(latest?.saving).toBe(false);
  });

  // @req ACCT-NEWS-01[parrot]
  it("hides the row without a bridge and keeps the switch disabled when the account cannot be read", async () => {
    await mount(undefined);
    expect(latest?.value).toBeUndefined();
    await act(async () => root?.unmount());

    const saveNewsOptIn = vi.fn(async () => ({ ok: false as const }));
    await mount({ getNewsOptIn: async () => ({ ok: false }), saveNewsOptIn });
    expect(latest?.value).toBeNull();

    // A failed save keeps the last known value instead of showing a choice the server did not record.
    await act(async () => latest!.set(true));
    expect(latest?.value).toBeNull();
  });
});
