// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const saveClientConfig = vi.fn();
vi.mock("../src/renderer/src/lib/config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveClientConfig: (...args: unknown[]) => saveClientConfig(...args),
}));
import { loadClientConfig } from "../src/renderer/src/lib/config";
import {
  LIBRARY_VIEW_PREFS_KEY,
  useLibraryViewPrefs,
  type LibraryViewPrefsState,
} from "../src/renderer/src/lib/libraryViewPrefs";

type Hook = LibraryViewPrefsState;

let root: Root | null = null;
let container: HTMLElement | null = null;
let latest: Hook | null = null;

const Probe = () => {
  latest = useLibraryViewPrefs();
  return null;
};

const mountProbe = () => {
  container = document.createElement("div");
  root = createRoot(container);
  act(() => {
    root?.render(<Probe />);
  });
};

const unmountProbe = () => {
  act(() => root?.unmount());
  root = null;
  container = null;
};

beforeEach(() => {
  localStorage.clear();
  latest = null;
});

afterEach(() => {
  if (root) unmountProbe();
});

describe("desktop library view prefs (per device, not synced)", () => {
  // @bugfix @regression-proof: view/sort lived in the synced ClientConfig, so one desktop's choice was shared with every
  // other desktop and each click pushed a remote op.
  it("@bugfix @regression-proof changing view or sort never writes the synced client config, and persists locally", () => {
    mountProbe();
    expect(latest?.[0].movie).toEqual({ view: "posters", sortBy: "name", sortDirection: "asc" });

    act(() => latest?.[1]("movie", { view: "details" }));
    act(() => latest?.[1]("movie", { sortBy: "release", sortDirection: "desc" }));
    act(() => latest?.[1]("tv", { view: "compact" }));

    expect(saveClientConfig).not.toHaveBeenCalled();
    expect(localStorage.getItem("sf_client_config_v1")).toBeNull();
    expect(loadClientConfig()).not.toHaveProperty("libraryView");
    expect(latest?.[0].movie).toEqual({ view: "details", sortBy: "release", sortDirection: "desc" });
    expect(latest?.[0].tv).toEqual({ view: "compact", sortBy: "name", sortDirection: "asc" });
    expect(JSON.parse(localStorage.getItem(LIBRARY_VIEW_PREFS_KEY) ?? "null")).toEqual(latest?.[0]);

    unmountProbe();
    mountProbe();
    expect(latest?.[0].movie).toEqual({ view: "details", sortBy: "release", sortDirection: "desc" });
    expect(latest?.[0].tv.view).toBe("compact");
  });

  it("falls back to defaults for corrupt stored values", () => {
    localStorage.setItem(LIBRARY_VIEW_PREFS_KEY, "{not json");
    mountProbe();
    expect(latest?.[0].movie).toEqual({ view: "posters", sortBy: "name", sortDirection: "asc" });
    unmountProbe();

    localStorage.setItem(
      LIBRARY_VIEW_PREFS_KEY,
      JSON.stringify({ movie: { view: "grid", sortBy: 3, sortDirection: "sideways" }, tv: "nope" }),
    );
    mountProbe();
    expect(latest?.[0].movie.view).toBe("posters");
    expect(latest?.[0].tv.sortBy).toBe("name");
  });
});
