// @vitest-environment jsdom
/**
 * @test-id DESKTOP-OFFLINE-NOTICE-001
 * @level unit
 * @req UX-NOTICE-02[badger-desktop] @req UX-NOTICE-01[badger-desktop]
 * @why Chris 2026-11-13 (design feedback): going offline is said once, in a toast that floats over the page and leaves
 *   on its own after the app's standard toast time (the shared sonner Toaster, top right), and never as a lasting bar.
 *   The toast is not repeated while the computer stays offline (page changes remount the top bar, so it lives once at
 *   the app level), and it is taken back when the connection returns, with nothing else shown.
 */
import React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { DesktopOfflineNotice, OFFLINE_TOAST_ID } from "@/components/DesktopOfflineIndicator";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const h = vi.hoisted(() => ({
  libraryError: null as string | null,
  OFFLINE_MSG: "You're offline. Showing your downloaded titles.",
  SYNC_MSG: "Sync is temporarily unavailable. You're using local data until it recovers.",
  toast: Object.assign(vi.fn(), { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/lib/libraryContext", () => ({
  useLibraryShell: () => ({ error: h.libraryError }),
  useLibraryActions: () => ({ reload: () => undefined }),
  isOfflineModeFallbackMessage: (m: string | null | undefined) => typeof m === "string" && m.trim() === h.OFFLINE_MSG,
  isSyncUnavailableFallbackMessage: (m: string | null | undefined) => typeof m === "string" && m.trim() === h.SYNC_MSG,
}));
vi.mock("@space/ui", () => ({ toast: h.toast }));

let container: HTMLDivElement;
let root: Root;

const log = (step: string, detail: unknown) => console.info(`[DESKTOP-OFFLINE-NOTICE-001] ${step}`, JSON.stringify(detail));
const calls = () => ({
  warning: h.toast.warning.mock.calls,
  success: h.toast.success.mock.calls,
  plain: h.toast.mock.calls,
  dismiss: h.toast.dismiss.mock.calls,
});
const setOnline = (value: boolean) => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
const render = () =>
  act(() => {
    root.render(<DesktopOfflineNotice />);
  });
const goOffline = () => {
  setOnline(false);
  act(() => {
    window.dispatchEvent(new Event("offline"));
  });
};
const goOnline = () => {
  setOnline(true);
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  setOnline(true);
  h.libraryError = null;
  for (const fn of [h.toast, h.toast.warning, h.toast.success, h.toast.error, h.toast.info, h.toast.dismiss]) fn.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setOnline(true);
});

describe("DesktopOfflineNotice (UX-NOTICE-02)", () => {
  it("says nothing while online", () => {
    render();
    log("online", calls());
    expect(h.toast.warning).not.toHaveBeenCalled();
    expect(h.toast.dismiss).not.toHaveBeenCalled();
    expect(container.innerHTML, "it draws nothing in the page").toBe("");
  });

  it("going offline shows one toast with the standard time, never repeated while offline", () => {
    render();
    goOffline();
    goOffline();
    render();
    log("offline", calls());
    expect(h.toast.warning).toHaveBeenCalledTimes(1);
    const [title, options] = h.toast.warning.mock.calls[0];
    expect(title).toBe("library.offline.toastTitle");
    expect(options).toMatchObject({ id: OFFLINE_TOAST_ID, description: "library.offline.toastBody" });
    expect(options.duration, "the app's standard toast time applies").toBeUndefined();
    expect(container.innerHTML).toBe("");
  });

  it("coming back online takes the toast back and shows nothing else", () => {
    render();
    goOffline();
    goOnline();
    log("back online", calls());
    expect(h.toast.dismiss).toHaveBeenCalledWith(OFFLINE_TOAST_ID);
    expect(h.toast.warning).toHaveBeenCalledTimes(1);
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("starting with the library offline says it once", () => {
    h.libraryError = h.OFFLINE_MSG;
    render();
    render();
    log("library offline at start", calls());
    expect(h.toast.warning).toHaveBeenCalledTimes(1);
    expect(h.toast.warning.mock.calls[0][0]).toBe("library.offline.toastTitle");
  });

  it("sync paused on local data says so once, without the word offline", () => {
    h.libraryError = h.SYNC_MSG;
    render();
    log("sync paused", calls());
    expect(h.toast.warning).toHaveBeenCalledTimes(1);
    expect(h.toast.warning.mock.calls[0][0]).toBe("library.offline.syncToastTitle");
    expect(h.toast.warning.mock.calls[0][1]).toMatchObject({ id: OFFLINE_TOAST_ID, description: "library.offline.syncToastBody" });
  });
});
