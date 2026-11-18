// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { useLibraryDetailsPrefetch } from "../src/renderer/src/lib/useLibraryDetailsPrefetch";

type Pending = { id: string; resolve: () => void };

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
});

/** A details cache whose fetches stay pending until the test settles them, tracking how many run at once. */
const makeBackend = (cached: readonly string[] = []) => {
  const cache = new Set<string>(cached);
  const started: string[] = [];
  const pending: Pending[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    started,
    pending,
    get maxInFlight() {
      return maxInFlight;
    },
    getDetails: (id: string) => (cache.has(id) ? { id } : null),
    fetchDetails: (id: string) => {
      started.push(id);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<void>((resolve) => {
        pending.push({
          id,
          resolve: () => {
            cache.add(id);
            inFlight -= 1;
            resolve();
          },
        });
      });
    },
  };
};

type Backend = ReturnType<typeof makeBackend>;

const IDS = ["a", "b", "c", "d"];

const mount = (backend: Backend) => {
  // Like the Library page: every render builds fresh arrays and closures for the same titles.
  const Probe = ({ tick }: { tick: number }) => {
    useLibraryDetailsPrefetch(
      true,
      IDS.map((id) => ({ id })),
      (id) => backend.getDetails(id),
      (id) => backend.fetchDetails(id),
    );
    return <span>{tick}</span>;
  };
  container = document.createElement("div");
  root = createRoot(container);
  const render = (tick: number) =>
    act(() => {
      root?.render(<Probe tick={tick} />);
    });
  render(0);
  return render;
};

const settleNext = async (backend: Backend) => {
  const next = backend.pending.shift();
  await act(async () => {
    next?.resolve();
    await Promise.resolve();
  });
};

describe("useLibraryDetailsPrefetch", () => {
  // @bugfix @regression-proof: the effect depended on per-render arrays and closures, so it re-ran on every render and
  // started a second concurrent fetch loop while the first title was still loading.
  it("@bugfix @regression-proof fetches one title at a time however often the page re-renders", async () => {
    const backend = makeBackend();
    const render = mount(backend);
    for (let tick = 1; tick <= 6; tick += 1) render(tick);

    expect(backend.started).toEqual(["a"]);
    expect(backend.maxInFlight).toBe(1);

    for (const expected of [["a", "b"], ["a", "b", "c"], ["a", "b", "c", "d"]]) {
      await settleNext(backend);
      render(100 + expected.length);
      expect(backend.started).toEqual(expected);
      expect(backend.maxInFlight).toBe(1);
    }
    await settleNext(backend);
    render(200);
    // Every title was fetched exactly once.
    expect(backend.started).toEqual(IDS);
    expect(backend.maxInFlight).toBe(1);
  });

  it("skips titles that already have details and never refetches one", async () => {
    const backend = makeBackend(["a", "b"]);
    const render = mount(backend);
    expect(backend.started).toEqual(["c"]);
    await settleNext(backend);
    render(1);
    expect(backend.started).toEqual(["c", "d"]);
    await settleNext(backend);
    render(2);
    render(3);
    expect(backend.started).toEqual(["c", "d"]);
  });
});
