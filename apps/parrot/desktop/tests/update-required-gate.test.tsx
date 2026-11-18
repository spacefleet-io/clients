// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-UPDATE-REQUIRED-001
 * @level integration (real App gate over the real shared updater hook and update card; `window.parrot` bridge faked)
 * @req REL-CD-29
 * @why A Parrot build the API refuses with "please update" (426), or that release-status reports below the minimum,
 *   must show a screen that only offers the update, on top of every screen (sign-in included), and check once for the
 *   update the user now needs. Main makes every API call, so the refusal reaches the window over the bridge.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INITIAL_UPDATER_STATE, type UpdaterBridge, type UpdaterEvent, type UpdaterState } from "@space/desktop-shell/updater";
import type { AppUpdateRequiredPayload } from "@space/shared/appVersion";
import { UpdateRequiredGate } from "../src/renderer/src/UpdateRequiredGate";
import { updateSectionText } from "@space/desktop-shell/updater-strings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REFUSAL: AppUpdateRequiredPayload = { error: "app_update_required", app: "parrot", platform: "desktop", version: "0.1.3", minVersion: "0.1.5" };

const makeUpdater = (state: Partial<UpdaterState>): UpdaterBridge => ({
  check: vi.fn(async () => ({ status: "available" as const, version: "0.1.5" })),
  downloadUpdate: vi.fn(async () => ({ ok: true })),
  installAndRestart: vi.fn(async () => ({ ok: true })),
  setAutoUpdate: vi.fn(async () => ({ ok: true })),
  getState: vi.fn(async () => ({ ...INITIAL_UPDATER_STATE, autoUpdate: true, ...state })),
  onEvent: vi.fn((_listener: (event: UpdaterEvent) => void) => () => undefined),
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let emitRefusal: ((payload: AppUpdateRequiredPayload) => void) | null = null;

const mount = async ({ refused, mandatory }: { refused: boolean; mandatory: boolean }) => {
  const updater = makeUpdater({ mandatory });
  Object.assign(window, {
    parrot: {
      updater,
      getAppUpdateRequired: vi.fn(async () => (refused ? REFUSAL : null)),
      onAppUpdateRequired: vi.fn((listener: (payload: AppUpdateRequiredPayload) => void) => {
        emitRefusal = listener;
        return () => (emitRefusal = null);
      }),
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<UpdateRequiredGate language="en" />));
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
  return updater;
};

const gate = () => container!.querySelector('[data-testid="update-required"]');

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  emitRefusal = null;
});

describe("REL-CD-29 Parrot desktop: the update-required screen", () => {
  // @req REL-CD-29[parrot]
  it("stays hidden while the API accepts this build and release-status does not mark it below the minimum", async () => {
    const updater = await mount({ refused: false, mandatory: false });
    expect(gate()).toBeNull();
    expect(updater.check).not.toHaveBeenCalled();
  });

  // @req REL-CD-29[parrot]
  it("shows the blocking update screen and checks once when main reports a refusal", async () => {
    const updater = await mount({ refused: false, mandatory: false });
    await act(async () => emitRefusal!(REFUSAL));
    await act(async () => Promise.resolve());
    expect(gate()?.textContent).toContain("Update Parrot to keep using it");
    expect(gate()?.textContent).toContain(updateSectionText("en", "requiredBody", { app: "Parrot" }));
    expect(gate()?.querySelector('[data-testid="update-section"]')).not.toBeNull();
    // Nothing closes it: the only control is the update card's own button (and its automatic-updates switch).
    expect([...gate()!.querySelectorAll("button")].map((button) => button.dataset.testid)).toEqual([
      "update-section-action",
      "settings-auto-update-switch",
    ]);
    expect(updater.check).toHaveBeenCalledTimes(1);
  });

  // @req REL-CD-29[parrot]
  it("shows the screen for a refusal main already latched before the window opened", async () => {
    const updater = await mount({ refused: true, mandatory: false });
    expect(gate()).not.toBeNull();
    expect(updater.check).toHaveBeenCalledTimes(1);
  });

  // @req REL-CD-29[parrot]
  it("shows the screen without a new check when release-status marked this build mandatory", async () => {
    const updater = await mount({ refused: false, mandatory: true });
    expect(gate()).not.toBeNull();
    expect(updater.check).not.toHaveBeenCalled();
  });
});
