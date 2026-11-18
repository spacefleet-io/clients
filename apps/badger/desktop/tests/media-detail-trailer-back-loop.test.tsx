// @vitest-environment jsdom
/**
 * @test-id DESKTOP-MEDIA-DETAIL-TRAILER-BACK-LOOP-001
 * @level unit
 * @bugfix @regression-proof
 * @why 2026-11-09 staging: on a media detail page (/media/<id>) Back returned to the `?trailer=<key>` history entry
 *      the trailer had pushed. The page's two effects then fought: URL -> state set the open trailer from the param
 *      while state -> URL (still holding the stale, closed trailer) wrote the param back, every commit, mounting and
 *      unmounting the trailer Dialog's Radix Portal each time. React threw "Maximum update depth exceeded" in
 *      <ForwardRef(Portal)> and the window went dark.
 * @covers apps/badger/desktop/src/renderer/src/lib/useTrailerParamSync.ts
 */
import React, { act, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTrailerParamSync } from "../src/renderer/src/lib/useTrailerParamSync";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TAG = "[DESKTOP-MEDIA-DETAIL-TRAILER-BACK-LOOP-001]";
// Past this many URL writes the harness stops writing, so a loop ends instead of hanging the run.
const WRITE_CAP = 60;

const writes: Array<string | null> = [];
const locations: string[] = [];

/** Portal that, like Radix's, sets state in a layout effect when it mounts. */
function TrailerPortal({ trailerKey }: { trailerKey: string }) {
  const [mounted, setMounted] = useState(false);
  React.useLayoutEffect(() => setMounted(true), []);
  return mounted ? createPortal(<div data-testid="trailer">{trailerKey}</div>, document.body) : null;
}

/** The detail page's trailer wiring, as MediaDetailsDialog has it. */
function DetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTrailerKey, setActiveTrailerKey] = useState<string | null>(null);
  locations.push(`${location.pathname}${location.search}`);
  useTrailerParamSync({
    selectedId: id ?? null,
    detailsId: id ?? null,
    searchTrailerParam: searchParams.get("trailer"),
    activeTrailerKey,
    setActiveTrailerKey,
    setTrailerParam: (key) => {
      writes.push(key);
      if (writes.length > WRITE_CAP) return;
      const next = new URLSearchParams(searchParams);
      if (key) next.set("trailer", key);
      else next.delete("trailer");
      setSearchParams(next);
    },
  });
  return (
    <div>
      <button data-testid="open" onClick={() => setActiveTrailerKey("yt-1")}>open</button>
      <button data-testid="close" onClick={() => setActiveTrailerKey(null)}>close</button>
      <button data-testid="back" onClick={() => navigate(-1)}>back</button>
      <span data-testid="active">{activeTrailerKey ?? "none"}</span>
      {activeTrailerKey ? <TrailerPortal trailerKey={activeTrailerKey} /> : null}
    </div>
  );
}

describe("media detail page: Back onto a ?trailer= entry settles", () => {
  let container: HTMLDivElement;
  let root: Root;
  let uncaught: unknown[];

  beforeEach(() => {
    writes.length = 0;
    locations.length = 0;
    uncaught = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container, { onUncaughtError: (error) => uncaught.push(error) });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const click = (testId: string) => {
    const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement;
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    console.info(`${TAG} clicked ${testId}: url=${locations.at(-1)} active=${container.querySelector('[data-testid="active"]')?.textContent} writes=${writes.length}`);
  };

  it("opening, closing, then Back leaves the trailer open once, with no write loop", () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/media-library", "/media/m1"]} initialIndex={1}>
          <Routes>
            <Route path="/media/:id" element={<DetailPage />} />
            <Route path="/media-library" element={<div data-testid="library">library</div>} />
          </Routes>
        </MemoryRouter>
      );
    });
    console.info(`${TAG} mounted at ${locations.at(-1)}`);

    click("open");
    click("close");
    expect(writes).toEqual(["yt-1", null]);

    const writesBeforeBack = writes.length;
    const rendersBeforeBack = locations.length;
    click("back");
    const loopWrites = writes.length - writesBeforeBack;
    const rendersAfterBack = locations.length - rendersBeforeBack;
    console.info(`${TAG} after Back: url writes=${loopWrites} renders=${rendersAfterBack} uncaught=${uncaught.map(String).join(" | ") || "none"}`);
    console.info(`${TAG} write log: ${JSON.stringify(writes.slice(0, 12))}${writes.length > 12 ? " …" : ""}`);

    expect(uncaught.map(String).filter((m) => m.includes("Maximum update depth"))).toEqual([]);
    expect(loopWrites).toBe(0);
    expect(rendersAfterBack).toBeLessThan(6);
    expect(locations.at(-1)).toBe("/media/m1?trailer=yt-1");
    expect(container.querySelector('[data-testid="active"]')?.textContent).toBe("yt-1");
  });

  it("a deep link /media/<id>?trailer=<key> opens the trailer without rewriting the URL", () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/media/m1?trailer=yt-2"]}>
          <Routes>
            <Route path="/media/:id" element={<DetailPage />} />
          </Routes>
        </MemoryRouter>
      );
    });
    console.info(`${TAG} deep link: url=${locations.at(-1)} writes=${JSON.stringify(writes.slice(0, 12))} uncaught=${uncaught.length}`);
    expect(uncaught).toEqual([]);
    expect(writes).toEqual([]);
    expect(container.querySelector('[data-testid="active"]')?.textContent).toBe("yt-2");
  });
});
