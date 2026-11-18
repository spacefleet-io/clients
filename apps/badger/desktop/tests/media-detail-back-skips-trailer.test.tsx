// @vitest-environment jsdom
/**
 * @test-id DESKTOP-MEDIA-DETAIL-BACK-SKIPS-TRAILER-001
 * @level unit
 * @bugfix @regression-proof @req LIB-DETAIL-05
 * @why 2026-11-12 (Chris): Library → "Les Choristes" → Trailer → close → Play, then "← Library" on
 *      the detail page reopened the trailer instead of showing the library. Opening the trailer pushed
 *      `/media/<id>?trailer=<key>`, closing it pushed `/media/<id>` on top, and the back link did `navigate(-1)`, which
 *      landed on the `?trailer=` entry and the URL → state sync opened the trailer again.
 * @covers apps/badger/desktop/src/renderer/src/lib/mediaDetailHistory.ts
 * @covers apps/badger/desktop/src/renderer/src/lib/useTrailerParamSync.ts
 */
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useMediaDetailHistory } from "../src/renderer/src/lib/mediaDetailHistory";
import { mediaDetailPath } from "../src/renderer/src/lib/mediaDetailRoute";
import { useTrailerParamSync } from "../src/renderer/src/lib/useTrailerParamSync";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TAG = "[DESKTOP-MEDIA-DETAIL-BACK-SKIPS-TRAILER-001]";

const locations: string[] = [];

function LocationProbe() {
  const location = useLocation();
  locations.push(`${location.pathname}${location.search}`);
  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

/** Library and Home open a title the way the real pages do: push `?media=<id>`, then redirect (replace) to the page. */
function Shelf({ name }: { name: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("media");
  return (
    <div data-testid={name}>
      <button data-testid="open-film" onClick={() => setSearchParams({ media: "les-choristes" })}>
        film
      </button>
      <button data-testid="open-episode" onClick={() => setSearchParams({ media: "show-1", episode: "s1e2" })}>
        episode
      </button>
      {selectedId ? <Navigate replace to={mediaDetailPath(selectedId, searchParams)} /> : null}
    </div>
  );
}

/** The detail page's URL wiring, as MediaDetail + MediaDetailsDialog have it. */
function DetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { searchParams, setTrailerParam, back } = useMediaDetailHistory();
  const [activeTrailerKey, setActiveTrailerKey] = useState<string | null>(null);
  useTrailerParamSync({
    selectedId: id ?? null,
    detailsId: id ?? null,
    searchTrailerParam: searchParams.get("trailer"),
    activeTrailerKey,
    setActiveTrailerKey,
    setTrailerParam,
  });
  return (
    <div data-testid="detail">
      <button data-testid="open-trailer" onClick={() => setActiveTrailerKey("yt-choristes")}>
        trailer
      </button>
      {/* The trailer Dialog's close (X, Escape, outside click) and the details refresh after Play both clear the key. */}
      <button data-testid="close-trailer" onClick={() => setActiveTrailerKey(null)}>
        close
      </button>
      <button data-testid="back-link" onClick={back}>
        ← Library
      </button>
      <button data-testid="browser-back" onClick={() => navigate(-1)}>
        browser back
      </button>
      <span data-testid="trailer">{activeTrailerKey ?? "none"}</span>
    </div>
  );
}

describe("media detail page: the back link never lands on the trailer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    locations.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
  const has = (testId: string) => container.querySelector(`[data-testid="${testId}"]`) !== null;
  const dump = (label: string) =>
    console.info(`${TAG} ${label}: url=${text("url")} trailer=${text("trailer")} history=${JSON.stringify(locations.slice(-8))}`);

  const click = (testId: string) => {
    const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
    if (!el) {
      dump(`missing ${testId}`);
      throw new Error(`${TAG} no element ${testId}`);
    }
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    dump(`clicked ${testId}`);
  };

  const mount = (initialEntries: string[]) => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.length - 1}>
          <LocationProbe />
          <Routes>
            <Route path="/media-library" element={<Shelf name="library" />} />
            <Route path="/home" element={<Shelf name="home" />} />
            <Route path="/media/:id" element={<DetailPage />} />
          </Routes>
        </MemoryRouter>
      );
    });
    dump(`mounted at ${initialEntries.join(" → ")}`);
  };

  it("Library → film → trailer → close → Play → ← Library shows the library, no trailer", () => {
    mount(["/media-library"]);
    click("open-film");
    expect(text("url")).toBe("/media/les-choristes");
    click("open-trailer");
    expect(text("url")).toBe("/media/les-choristes?trailer=yt-choristes");
    click("close-trailer");
    expect(text("url")).toBe("/media/les-choristes");
    expect(text("trailer")).toBe("none");
    click("back-link");
    dump("after back link");
    expect(has("library")).toBe(true);
    expect(text("url")).toBe("/media-library");
    expect(has("detail")).toBe(false);
  });

  it("Home → film → trailer → close → ← back returns Home", () => {
    mount(["/home"]);
    click("open-film");
    click("open-trailer");
    click("close-trailer");
    click("back-link");
    expect(text("url")).toBe("/home");
    expect(has("home")).toBe(true);
  });

  it("a TV episode opened from the Library: trailer twice, then ← Library shows the library", () => {
    mount(["/media-library"]);
    click("open-episode");
    expect(text("url")).toBe("/media/show-1?episode=s1e2");
    click("open-trailer");
    click("close-trailer");
    click("open-trailer");
    click("close-trailer");
    expect(text("url")).toBe("/media/show-1?episode=s1e2");
    click("back-link");
    expect(text("url")).toBe("/media-library");
    expect(has("library")).toBe(true);
  });

  it("browser Back after closing the trailer stays on the page without reopening it", () => {
    mount(["/media-library"]);
    click("open-film");
    click("open-trailer");
    click("close-trailer");
    click("browser-back");
    dump("after browser back");
    expect(text("trailer")).toBe("none");
    expect(text("url")).not.toContain("trailer=");
  });

  it("browser Back while the trailer is open still closes it", () => {
    mount(["/media-library"]);
    click("open-film");
    click("open-trailer");
    click("browser-back");
    expect(text("url")).toBe("/media/les-choristes");
    expect(text("trailer")).toBe("none");
    click("back-link");
    expect(text("url")).toBe("/media-library");
  });

  it("a restored detail page (first entry) goes to the library after a trailer", () => {
    mount(["/media/les-choristes"]);
    click("open-trailer");
    click("close-trailer");
    click("back-link");
    expect(text("url")).toBe("/media-library");
    expect(text("trailer")).toBe(null);
  });
});
