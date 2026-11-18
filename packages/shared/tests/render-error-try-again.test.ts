// @req UX-CRASH-01[badger-desktop] @req UX-CRASH-01[parrot] @req UX-CRASH-01[badger-mobile] @bugfix @regression-proof
// Chris 2026-11-12 (chat): "Retry never works". What a guard does with a crash after "Try again": reload once when the
// retry failed within a few seconds, never again while the marker of that reload is fresh (no reload loop).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RELOAD_MARKER_TTL_MS,
  RETRY_FAILED_WITHIN_MS,
  crashAfterRetry,
  memoryReloadMarker,
  sessionReloadMarker,
} from "../src/renderError";

const log = (phase: string, message: string, extra?: unknown) =>
  console.info(`[render-error-try-again.test] [${phase}] ${message}`, extra ?? "");

describe("crashAfterRetry", () => {
  const now = 10_000_000;

  it("shows the notice for a crash with no press of Try again before it", () => {
    const marker = memoryReloadMarker();
    expect(crashAfterRetry({ retriedAt: null, now, marker })).toBe("show");
    expect(marker.read()).toBeNull();
  });

  it("reloads when the crash comes within the retry window, and writes the marker", () => {
    const marker = memoryReloadMarker();
    const next = crashAfterRetry({ retriedAt: now - RETRY_FAILED_WITHIN_MS, now, marker });
    log("decide", "within window", next);
    expect(next).toBe("reload");
    expect(marker.read()).toBe(now);
  });

  it("shows the notice when the crash comes after the retry window (the retry worked for a while)", () => {
    const marker = memoryReloadMarker();
    expect(crashAfterRetry({ retriedAt: now - RETRY_FAILED_WITHIN_MS - 1, now, marker })).toBe("show");
    expect(marker.read()).toBeNull();
  });

  it("never reloads twice while the marker is fresh; reloads again once it expired", () => {
    const marker = memoryReloadMarker();
    marker.write(now - RELOAD_MARKER_TTL_MS + 1);
    expect(crashAfterRetry({ retriedAt: now - 100, now, marker })).toBe("show");
    marker.write(now - RELOAD_MARKER_TTL_MS);
    expect(crashAfterRetry({ retriedAt: now - 100, now, marker })).toBe("reload");
  });
});

describe("sessionReloadMarker", () => {
  const key = "sf:render-boundary:test-marker";
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the time in sessionStorage, so it outlives a page reload (a new marker reads it)", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    sessionReloadMarker(key).write(1234);
    log("storage", "stored", Object.fromEntries(store));
    expect(sessionReloadMarker(key).read()).toBe(1234);
    store.delete(key);
    expect(sessionReloadMarker(key).read()).toBeNull();
  });

  it("falls back to memory when there is no sessionStorage", () => {
    const marker = sessionReloadMarker(key);
    expect(marker.read()).toBeNull();
    marker.write(42);
    expect(marker.read()).toBe(42);
  });
});
