// @vitest-environment jsdom
/**
 * @test-id DESKTOP-OFFLINE-INDICATOR-001
 * @level unit
 * @req UX-NOTICE-02[badger-desktop] @req OFFL-PLAY-02
 * @why Chris 2026-11-13 (design feedback): offline is a normal state, so the computer shows it with a small chip beside
 *   the Badger name in the top bar, never a full-width red bar under it ("You're offline — using cached data"). The
 *   chip says one word, its accessible label says the saved content is shown, and when the library itself is offline
 *   (server unreachable) or sync is paused, clicking it retries. It appears when the OS goes offline and goes as soon
 *   as the connection is back. The passing notice that says it once is pinned in DESKTOP-OFFLINE-NOTICE-001.
 *
 * Coverage:
 *   - nothing while online
 *   - OS offline: a status chip, no retry
 *   - library offline (server unreachable, OS online): a retry chip; click -> reload(), label flips to Reconnecting
 *   - sync unavailable (local data in use): a "Not synced" retry chip
 *   - offline / online window events show and hide it
 *   - compact: a small pill, never a full-width bar, no sentence
 */
import React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { DesktopOfflineIndicator } from "@/components/DesktopOfflineIndicator";

(globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// `h.libraryError` is mutable so tests can toggle library offline mode and the sync-unavailable fallback.
const h = vi.hoisted(() => ({
  libraryError: null as string | null,
  // Must match OFFLINE_MODE_FALLBACK_MESSAGE and SYNC_UNAVAILABLE_FALLBACK_MESSAGE in libraryContext.tsx.
  OFFLINE_MSG: "You're offline. Showing your downloaded titles.",
  SYNC_MSG: "Sync is temporarily unavailable. You're using local data until it recovers.",
  reload: vi.fn(),
}));
vi.mock("@/lib/libraryContext", () => ({
  useLibraryShell: () => ({ error: h.libraryError }),
  useLibraryActions: () => ({ reload: h.reload }),
  isOfflineModeFallbackMessage: (m: string | null | undefined) => typeof m === "string" && m.trim() === h.OFFLINE_MSG,
  isSyncUnavailableFallbackMessage: (m: string | null | undefined) => typeof m === "string" && m.trim() === h.SYNC_MSG,
}));

let container: HTMLDivElement;
let root: Root;

const chip = () => container.querySelector<HTMLElement>('[data-testid="desktop-offline-indicator"]');

// On failure, dump navigator.onLine, the library error and the chip as rendered.
const dump = (label: string) => {
  try {
    const el = chip();
    console.error(`=== [desktop-offline-indicator:${label}] snapshot ===`);
    console.error(`navigator.onLine=${navigator.onLine} libraryError=${JSON.stringify(h.libraryError)}`);
    console.error(`chip=${el ? el.outerHTML : "(none)"}`);
    console.error(`container.innerHTML=${JSON.stringify(container?.innerHTML ?? null)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};
const check = (label: string, assertions: () => void) => {
  try {
    assertions();
  } catch (err) {
    dump(label);
    throw err;
  }
};

const setOnline = (value: boolean) => {
  console.info(`[desktop-offline-indicator:set-online] navigator.onLine := ${value}`);
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  setOnline(true);
  h.libraryError = null;
  h.reload.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setOnline(true);
  vi.restoreAllMocks();
});

const render = () => {
  act(() => {
    root.render(<DesktopOfflineIndicator />);
  });
};

describe("DesktopOfflineIndicator (the small offline chip)", () => {
  it("renders nothing while online", () => {
    render();
    check("online", () => expect(chip()).toBeNull());
  });

  it("OS offline: a one-word status chip with a full accessible label, and no retry", () => {
    setOnline(false);
    render();
    const el = chip();
    console.info(`[desktop-offline-indicator:network] ${el?.outerHTML}`);
    check("network", () => {
      expect(el).not.toBeNull();
      expect(el!.getAttribute("data-offline-source")).toBe("network");
      expect(el!.getAttribute("role")).toBe("status");
      expect(el!.textContent).toBe("library.offline.indicator");
      expect(el!.getAttribute("aria-label")).toBe("library.offline.indicatorLabel");
      expect(el!.tagName).not.toBe("BUTTON");
      expect(container.querySelector("button")).toBeNull();
    });
  });

  it("is a compact pill, never a full-width bar with a sentence", () => {
    setOnline(false);
    render();
    const el = chip();
    const classes = (el?.className ?? "").split(/\s+/);
    console.info(`[desktop-offline-indicator:compact] classes=${JSON.stringify(classes)}`);
    check("compact", () => {
      expect(classes).toContain("rounded-full");
      expect(classes).toContain("h-7");
      expect(classes).not.toContain("w-full");
      expect(classes).not.toContain("justify-center");
      expect(el!.textContent).not.toMatch(/cache|—/);
    });
  });

  it("library offline even with the OS online: a retry chip; clicking reloads and says Reconnecting", () => {
    h.libraryError = h.OFFLINE_MSG;
    render();
    check("library", () => {
      const el = chip()!;
      expect(el.tagName).toBe("BUTTON");
      expect(el.getAttribute("data-offline-source")).toBe("library");
      expect(el.textContent).toBe("library.offline.indicator");
      expect(el.getAttribute("aria-label")).toBe("library.offline.indicatorRetryLabel");
    });
    act(() => chip()!.click());
    check("library-retry", () => {
      expect(h.reload).toHaveBeenCalledTimes(1);
      expect(chip()!.textContent).toBe("library.offline.reconnecting");
    });
  });

  it("sync paused on local data: a 'Not synced' retry chip", () => {
    h.libraryError = h.SYNC_MSG;
    render();
    check("sync", () => {
      const el = chip()!;
      expect(el.tagName).toBe("BUTTON");
      expect(el.getAttribute("data-offline-source")).toBe("sync");
      expect(el.textContent).toBe("library.offline.syncIndicator");
      expect(el.getAttribute("aria-label")).toBe("library.offline.syncIndicatorRetryLabel");
    });
    act(() => chip()!.click());
    check("sync-retry", () => expect(h.reload).toHaveBeenCalledTimes(1));
  });

  it("appears when the OS goes offline and goes when it comes back", () => {
    render();
    check("before", () => expect(chip()).toBeNull());
    setOnline(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    check("went-offline", () => expect(chip()).not.toBeNull());
    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    check("back-online", () => expect(chip()).toBeNull());
  });
});
