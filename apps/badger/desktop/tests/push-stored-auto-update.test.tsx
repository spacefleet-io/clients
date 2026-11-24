// @vitest-environment jsdom

/**
 * usePushStoredAutoUpdate (REL-UPD-01): at start, Badger pushes the stored auto-update window setting to the main
 * process once, so the start-up and background checks follow it. The update modal itself is the shared
 * `DesktopUpdatePrompt` (packages/desktop-shell/tests/update-prompt.test.tsx).
 *
 * @req REL-UPD-01
 */

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { usePushStoredAutoUpdate } from "@/lib/useUpdater";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockConfig = vi.hoisted(() => ({ autoUpdate: true }));
vi.mock("@/lib/config", () => ({
  loadClientConfig: () => ({ uiLanguage: "en", autoUpdate: mockConfig.autoUpdate }),
}));

type SetAutoUpdate = (enabled: boolean) => Promise<void>;

let container: HTMLDivElement;
let root: Root;
let setAutoUpdate: Mock<SetAutoUpdate>;
let renders = 0;

const Probe = () => {
  usePushStoredAutoUpdate();
  renders += 1;
  return null;
};

const render = () =>
  act(() => {
    root.render(React.createElement(Probe));
  });

const dump = (testId: string) =>
  console.info(`[${testId}] renders=${renders} setAutoUpdate.calls=${JSON.stringify(setAutoUpdate.mock.calls)}`);

beforeEach(() => {
  mockConfig.autoUpdate = true;
  renders = 0;
  setAutoUpdate = vi.fn<SetAutoUpdate>(async () => undefined);
  vi.stubGlobal("spaceBadger", { updater: { setAutoUpdate } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("usePushStoredAutoUpdate", () => {
  // @req REL-UPD-01
  it.each([true, false])("pushes the stored autoUpdate=%s to the main process once on mount", (stored) => {
    const testId = `push-stored-auto-update:push-${stored}`;
    console.info(`[${testId}] phase:render twice with stored autoUpdate=${stored}`);
    mockConfig.autoUpdate = stored;
    render();
    render();
    dump(testId);
    expect(renders).toBe(2);
    expect(setAutoUpdate).toHaveBeenCalledTimes(1);
    expect(setAutoUpdate).toHaveBeenCalledWith(stored);
  });

  // @req REL-UPD-01
  it("survives a missing bridge (web / unsupported)", () => {
    const testId = "push-stored-auto-update:no-bridge";
    vi.stubGlobal("spaceBadger", undefined);
    console.info(`[${testId}] phase:render without window.spaceBadger`);
    expect(() => render()).not.toThrow();
    dump(testId);
    expect(renders).toBe(1);
    expect(setAutoUpdate).not.toHaveBeenCalled();
  });
});
