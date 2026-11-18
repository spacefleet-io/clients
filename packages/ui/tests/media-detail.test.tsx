// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  CAST_COLLAPSED_LINES,
  MediaDetailCast,
  MediaDetailGenres,
  MediaDetailPage,
  MediaDetailTabs,
  castColumns,
  castInitials,
  mediaDetailTabs,
} from "../src/badger/media-detail";

// @req LIB-DETAIL-01
describe("[media-detail] tab set", () => {
  it("desktop film: About, Versions & tracks, Subtitles, Jobs", () => {
    const tabs = mediaDetailTabs({ seasons: false, jobs: true });
    console.info("[media-detail] desktop film", tabs);
    expect(tabs).toEqual(["about", "versions", "subtitles", "jobs"]);
  });

  it("web film: the same tabs without Jobs (the website cannot ingest)", () => {
    const tabs = mediaDetailTabs({ seasons: false, jobs: false });
    console.info("[media-detail] web film", tabs);
    expect(tabs).toEqual(["about", "versions", "subtitles"]);
    expect(tabs).not.toContain("jobs");
  });

  it("desktop show keeps its seasons view first, then About and Jobs", () => {
    expect(mediaDetailTabs({ seasons: true, jobs: true })).toEqual(["seasons", "about", "jobs"]);
  });

  it("renders the tabs as a tablist with the active one selected", () => {
    const html = renderToStaticMarkup(
      <MediaDetailTabs
        label="Details"
        active="versions"
        onChange={() => {}}
        tabs={[
          { id: "about", label: "About" },
          { id: "versions", label: "Versions & tracks" },
        ]}
      />,
    );
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/aria-selected="true"[^>]*data-tab="versions"/);
  });
});

// @req LIB-DETAIL-02
describe("[media-detail] header", () => {
  it("is a page (no dialog) with a back link, version chips and the Play version marked", () => {
    const html = renderToStaticMarkup(
      <MediaDetailPage
        poster={<img src="p.jpg" alt="" />}
        backLabel="Library"
        onBack={() => {}}
        kindLabel="Movie"
        versions={[
          { id: "a", label: "4K · HEVC" },
          { id: "b", label: "1080p · H.264" },
        ]}
        playVersionId="b"
        title="Metropolis"
        meta="1927"
        actions={<button type="button">Play</button>}
      />,
    );
    console.info("[media-detail] header length", html.length);
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('data-testid="media-detail-back"');
    expect(html).toContain('data-version-chip="4K · HEVC"');
    expect(html).toMatch(/data-version-chip="1080p · H.264" data-plays="true"/);
    expect(html).toContain("<h1");
  });
});

// @req LIB-CAST-02[badger-desktop,badger-web-player]
describe("[media-detail] cast", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  });

  const labels = { heading: "Cast", unknownRole: "Unknown role", empty: "No cast", showLess: "Show less" };
  const people = (count: number) => Array.from({ length: count }, (_, i) => ({ id: String(i + 1), name: `Actor ${i + 1}`, role: `Role ${i + 1}` }));
  // jsdom has no layout: give every element the grid's width so the component's measure sees it.
  const atWidth = (width: number) =>
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  const shownNames = () => [...document.querySelectorAll("[data-cast-card]")].map((card) => card.getAttribute("data-cast-card"));

  it("draws portrait photo cards in a wrapping grid: 2:3 with poster corners, initials tile without a photo, name and role clipped to one line each", () => {
    const html = renderToStaticMarkup(
      <MediaDetailCast
        {...labels}
        showAll="Show all cast (2)"
        cast={[
          { id: "1", name: "Brigitte Helm", role: "Maria", avatar: <img src="helm.jpg" alt="Brigitte Helm" /> },
          { id: "2", name: "Alfred Abel", role: null },
        ]}
      />,
    );
    const grid = html.match(/<div class="([^"]*)" data-testid="media-detail-cast-grid"/)?.[1] ?? "";
    const cards = [...html.matchAll(/<div class="([^"]*)" data-cast-card="([^"]*)"><div class="([^"]*)">(.*?)<\/div>/g)];
    console.info("[media-detail] cast grid", grid, "cards", cards.map((card) => [card[2], card[1], card[4]]));
    expect(grid).toContain("grid-cols-[repeat(auto-fill,120px)]");
    expect(grid).not.toContain("overflow-x-auto");
    expect(cards.map((card) => card[2])).toEqual(["Brigitte Helm", "Alfred Abel"]);
    for (const card of cards) {
      expect(card[1]).toContain("w-[120px]");
      expect(card[3]).toContain("aspect-[2/3]");
      expect(card[3]).toContain("rounded-[4px]");
      expect(card[3]).not.toContain("rounded-full");
    }
    expect(cards[0]![4]).toContain('src="helm.jpg"');
    expect(cards[1]![4]).toBe("AA");
    expect(castInitials("Brigitte Helm")).toBe("BH");
    expect(html).toMatch(/class="[^"]*truncate[^"]*" title="Maria">Maria</);
    expect(html).toMatch(/class="[^"]*truncate[^"]*" title="Unknown role">Unknown role</);
    expect(html).toMatch(/class="[^"]*truncate[^"]*" title="Alfred Abel">Alfred Abel</);
    expect(html).not.toContain("media-detail-cast-toggle");
  });

  it("counts only whole 120 px cards per line, never a cut one", () => {
    const widths = [100, 120, 255, 256, 816, 1000];
    const counts = widths.map(castColumns);
    console.info("[media-detail] cast columns by width", Object.fromEntries(widths.map((w, i) => [w, counts[i]])));
    expect(counts).toEqual([1, 1, 1, 2, 6, 7]);
    for (const [i, width] of widths.entries()) {
      if (width >= 120) expect(counts[i]! * 120 + (counts[i]! - 1) * 16).toBeLessThanOrEqual(width);
    }
  });

  for (const { width, columns } of [
    { width: 816, columns: 6 },
    { width: 528, columns: 4 },
  ]) {
    it(`at ${width} px shows ${CAST_COLLAPSED_LINES} lines of ${columns}, then "Show all cast" expands in place and "Show less" folds back`, () => {
      atWidth(width);
      render(<MediaDetailCast {...labels} showAll="Show all cast (30)" cast={people(30)} />);
      const collapsed = shownNames();
      console.info(`[media-detail] cast at ${width}px collapsed`, collapsed.length, collapsed.at(-1));
      expect(screen.getByTestId("media-detail-cast-grid").getAttribute("data-columns")).toBe(String(columns));
      expect(collapsed).toHaveLength(columns * CAST_COLLAPSED_LINES);
      const toggle = screen.getByRole("button", { name: "Show all cast (30)" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(toggle);
      console.info(`[media-detail] cast at ${width}px expanded`, shownNames().length);
      expect(shownNames()).toEqual(people(30).map((p) => p.name));
      expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");

      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      expect(shownNames()).toEqual(collapsed);
      expect(screen.getByRole("button", { name: "Show all cast (30)" })).toBeTruthy();
    });
  }

  it("shows no button when the whole cast fits on two lines", () => {
    atWidth(816);
    render(<MediaDetailCast {...labels} showAll="Show all cast (12)" cast={people(12)} />);
    console.info("[media-detail] cast of 12 at 816px", shownNames().length);
    expect(shownNames()).toHaveLength(12);
    expect(screen.queryByTestId("media-detail-cast-toggle")).toBeNull();
  });

  it("says so when there is no cast", () => {
    const html = renderToStaticMarkup(<MediaDetailCast {...labels} showAll="Show all cast (0)" cast={[]} />);
    expect(html).toContain("No cast");
    expect(html).not.toContain("data-cast-card");
  });
});

// @req LIB-DETAIL-04[badger-desktop,badger-web-player]
describe("[media-detail] genres", () => {
  it("draws the genres as icon pills just under the meta line, in the app language", () => {
    const html = renderToStaticMarkup(
      <MediaDetailPage
        poster={null}
        backLabel="Library"
        onBack={() => {}}
        kindLabel="Movie"
        versions={[]}
        title="Black Hawk Down"
        meta="2001 · 7.4"
        genres={<MediaDetailGenres category="movie" ids={[28, 36, 10752]} language="fr" />}
        actions={null}
      />,
    );
    const meta = html.indexOf("2001 · 7.4");
    const pills = html.indexOf('data-testid="media-detail-genres"');
    console.info("[media-detail] genres meta@", meta, "pills@", pills, html.slice(pills, pills + 600));
    expect(meta).toBeGreaterThan(-1);
    expect(pills).toBeGreaterThan(meta);
    expect(html).not.toContain("Action ·");
    expect(html).toContain("Histoire");
    expect(html).toContain("Guerre");
    expect(html.slice(pills).match(/<svg/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("leaves out a genre id with no name, and renders nothing without genres", () => {
    const some = renderToStaticMarkup(<MediaDetailGenres category="tv" ids={[16, 999999]} language="en" />);
    const none = renderToStaticMarkup(<MediaDetailGenres category="movie" ids={[]} language="en" />);
    console.info("[media-detail] genres unknown", some, "| none", JSON.stringify(none));
    expect(some.match(/rounded-full/g)?.length).toBe(1);
    expect(some).toContain("Animation");
    expect(none).toBe("");
  });
});
