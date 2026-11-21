// @vitest-environment jsdom

/**
 * UpdateReadyNotice (REL-UPD-01): pushes the stored auto-update setting to the main process at start, and once a new
 * version finished downloading in the background shows a small "installs on quit — Restart now / Later" notice.
 * Mandatory updates and blocked screens keep it hidden (the blocking prompt owns those).
 */

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { UpdaterState } from "@/lib/useUpdater";
import UpdateReadyNotice from "@/components/UpdateReadyNotice";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && Object.keys(params).length > 0 ? `${key}(${JSON.stringify(params)})` : key,
  }),
}));

vi.mock("@space/ui", () => ({
  Button: ({ children, onClick, disabled, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { onClick, disabled, ...rest }, children),
}));

vi.mock("lucide-react", () => ({
  Download: () => React.createElement("span", { "aria-hidden": "true" }, "[↓]"),
}));

const mockUseUpdater = vi.hoisted(() => vi.fn());
vi.mock("@/lib/useUpdater", () => ({ useUpdater: mockUseUpdater }));

const mockConfig = vi.hoisted(() => ({ autoUpdate: true }));
vi.mock("@/lib/config", () => ({
  loadClientConfig: () => ({ uiLanguage: "en", autoUpdate: mockConfig.autoUpdate }),
}));

const baseState: UpdaterState = {
  phase: "downloaded",
  version: "1.4.0",
  releaseNotes: null,
  progress: 100,
  errorMessage: null,
  mandatory: false,
  autoUpdate: true,
  currentVersion: "1.3.0",
  lastCheckedAt: null,
  channel: "self",
  canInstall: false,
  manualCommand: null,
  failure: null,
  failureDetail: null,
};

let container: HTMLDivElement;
let root: Root;
let setAutoUpdate: ReturnType<typeof vi.fn>;
let install: ReturnType<typeof vi.fn>;

const setUpdater = (state: Partial<UpdaterState>) =>
  mockUseUpdater.mockReturnValue({
    state: { ...baseState, ...state },
    supported: true,
    check: vi.fn(async () => "idle"),
    download: vi.fn(async () => undefined),
    install,
    runFullUpdate: vi.fn(async () => undefined),
    reset: vi.fn(),
    setAutoUpdate: vi.fn(async () => undefined),
  });

const render = (blocked = false) =>
  act(() => {
    root.render(React.createElement(UpdateReadyNotice, { blocked }));
  });

const dump = (testId: string) =>
  console.info(
    `[${testId}] state=${JSON.stringify(mockUseUpdater.mock.results.at(-1)?.value?.state)} ` +
      `setAutoUpdate.calls=${JSON.stringify(setAutoUpdate.mock.calls)} install.calls=${install.mock.calls.length} ` +
      `html=${container.innerHTML}`,
  );

beforeEach(() => {
  mockConfig.autoUpdate = true;
  setAutoUpdate = vi.fn(async () => undefined);
  install = vi.fn();
  vi.stubGlobal("spaceBadger", { updater: { setAutoUpdate } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  mockUseUpdater.mockReset();
});

describe("UpdateReadyNotice", () => {
  // @req REL-UPD-01
  it.each([true, false])("pushes the stored autoUpdate=%s to the main process once on mount", (stored) => {
    const testId = `update-ready-notice:push-${stored}`;
    console.info(`[${testId}] phase:render stored autoUpdate=${stored}`);
    mockConfig.autoUpdate = stored;
    setUpdater({ phase: "idle" });
    render();
    render();
    dump(testId);
    expect(setAutoUpdate).toHaveBeenCalledTimes(1);
    expect(setAutoUpdate).toHaveBeenCalledWith(stored);
  });

  // @req REL-UPD-01
  it("survives a missing bridge (web / unsupported)", () => {
    const testId = "update-ready-notice:no-bridge";
    vi.stubGlobal("spaceBadger", undefined);
    setUpdater({ phase: "downloaded" });
    console.info(`[${testId}] phase:render without window.spaceBadger`);
    expect(() => render()).not.toThrow();
    dump(testId);
    expect(container.querySelector("[data-testid='update-ready-notice']")).not.toBeNull();
  });

  // @req REL-UPD-01
  it.each(["idle", "checking", "available", "downloading", "error", "unsupported"] as const)(
    "stays hidden in phase %s",
    (phase) => {
      const testId = `update-ready-notice:hidden-${phase}`;
      setUpdater({ phase });
      console.info(`[${testId}] phase:render`);
      render();
      dump(testId);
      expect(container.querySelector("[data-testid='update-ready-notice']")).toBeNull();
    },
  );

  // @req REL-UPD-01
  it("stays hidden for a mandatory update and on a blocked screen", () => {
    const testId = "update-ready-notice:hidden-mandatory-blocked";
    console.info(`[${testId}] phase:mandatory`);
    setUpdater({ mandatory: true });
    render();
    dump(testId);
    expect(container.querySelector("[data-testid='update-ready-notice']")).toBeNull();
    console.info(`[${testId}] phase:blocked`);
    setUpdater({});
    render(true);
    dump(testId);
    expect(container.querySelector("[data-testid='update-ready-notice']")).toBeNull();
  });

  // @req REL-UPD-01
  it("shows the downloaded version and Restart installs", async () => {
    const testId = "update-ready-notice:restart";
    setUpdater({});
    console.info(`[${testId}] phase:render downloaded 1.4.0`);
    render();
    dump(testId);
    const notice = container.querySelector("[data-testid='update-ready-notice']");
    expect(notice).not.toBeNull();
    expect(notice!.getAttribute("role")).toBe("status");
    expect(notice!.textContent).toContain("updater.ready.title");
    expect(notice!.textContent).toContain('updater.ready.body({"version":"1.4.0"})');
    const restart = container.querySelector<HTMLButtonElement>("[data-testid='update-ready-restart']");
    expect(restart?.textContent).toBe("updater.available.restart");
    console.info(`[${testId}] phase:click restart`);
    await act(async () => restart!.click());
    dump(testId);
    expect(install).toHaveBeenCalledTimes(1);
  });

  // @req REL-UPD-01
  it("Later hides the notice for that version only; a newer download shows it again", async () => {
    const testId = "update-ready-notice:later";
    setUpdater({});
    render();
    const later = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "updater.available.later",
    );
    console.info(`[${testId}] phase:click later`);
    await act(async () => later!.click());
    dump(testId);
    expect(container.querySelector("[data-testid='update-ready-notice']")).toBeNull();
    expect(install).not.toHaveBeenCalled();
    console.info(`[${testId}] phase:newer version downloaded`);
    setUpdater({ version: "1.5.0" });
    render();
    dump(testId);
    expect(container.querySelector("[data-testid='update-ready-notice']")).not.toBeNull();
  });
});
