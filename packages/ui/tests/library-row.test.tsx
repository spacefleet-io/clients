// @vitest-environment jsdom
/**
 * @test-id UI-LIBRARY-ROW-001
 * @level component
 * @why Chris (2026-11-20): Parrot's and Badger's library rows are one design — the switch, a divider and the quiet
 *   counts on the left, the Filter / Sort buttons (and the view button where there is one) on the right — pinned under
 *   the top bar while the library scrolls. One shared `LibraryRow` lays it out in theme colours; `PinnedRow` pins it
 *   and says when it has pinned (it gets the page's background then), whichever element scrolls; `LibraryCounts`
 *   draws "14 albums · 153 songs" with the numbers in the text colour.
 * @covers packages/ui/src/library-row.tsx
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryCounts, LibraryFilterButton, LibraryModal, LibraryPills, LibraryRow, LibrarySegmented, LibrarySortButton, PinnedRow } from "../src/library-row";
import { BadgerFilterPicker, FILTER_CHIP_LIMIT } from "../src/badger/library-menus";

const log = (msg: string, payload?: unknown) => console.info(`[library-row.test] ${msg}`, payload === undefined ? "" : JSON.stringify(payload));

/** Where an element sits on screen: jsdom lays nothing out, so each test places the row (and its scroller). */
const place = (el: Element, top: number, height: number) => {
  el.getBoundingClientRect = () => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) });
};

/** Scrolls an inner scroller, as Parrot's desktop <main> does: its scroll event does not bubble, so only capture sees it. */
const scrollInner = (scroller: Element) => act(() => void scroller.dispatchEvent(new Event("scroll")));

describe("PinnedRow (PAR-LIB-06, UX-LIB-01)", () => {
  beforeEach(() => {
    // Runs the frame at once; returns 0 (no frame pending) since the frame has already run by the time the id lands.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // @req PAR-LIB-06[parrot,parrot-web-player]
  // @req UX-LIB-01[badger-desktop,badger-web-player]
  it("is sticky at pinTop, and pins once the row sits on the stuck line of its own padded scroller", () => {
    // Parrot desktop: its <main> scrolls under the 64px bar with 32px of top padding, and the row is pulled up by it.
    render(
      <main data-testid="scroller" style={{ overflowY: "auto", paddingTop: "32px" }}>
        <PinnedRow pinTop={-32} testId="library-toolbar" logTag="test-library">
          <span>row</span>
        </PinnedRow>
      </main>
    );
    const scroller = screen.getByTestId("scroller");
    const row = screen.getByTestId("library-toolbar");
    place(scroller, 64, 836);
    log("mounted", { top: row.style.top, className: row.className });
    expect(row.className).toContain("sticky");
    expect(row.style.top).toBe("-32px");

    // At rest, or scrolled a little: the row sits below the stuck line (64 + 32 - 32).
    place(row, 81, 56);
    scrollInner(scroller);
    log("below the line", { pinned: row.getAttribute("data-pinned") });
    expect(row.getAttribute("data-pinned")).toBe("false");

    // Scrolled further: the row is held on the line under the bar.
    place(row, 64, 56);
    scrollInner(scroller);
    log("stuck", { pinned: row.getAttribute("data-pinned"), className: row.className });
    expect(row.getAttribute("data-pinned")).toBe("true");
    expect(row.className).toContain("bg-background/85");

    // Back to the top: unpinned and transparent again.
    place(row, 81, 56);
    act(() => void document.dispatchEvent(new Event("scroll")));
    log("back", { pinned: row.getAttribute("data-pinned") });
    expect(row.getAttribute("data-pinned")).toBe("false");
    expect(row.className).toContain("bg-transparent");
  });

  // @req UX-LIB-01[badger-desktop,badger-web-player]
  it("over a scrolling page, is not taken as pinned while it rests below the bar, whatever the gap above it", () => {
    // Badger: the window scrolls under a 64px bar; at rest the row sits 97px down (a parent's gap, not its own margin).
    render(
      <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
        <PinnedRow pinTop={64} testId="library-toolbar" logTag="test-library">
          <span>row</span>
        </PinnedRow>
      </div>
    );
    const row = screen.getByTestId("library-toolbar");
    place(row, 97, 62);
    act(() => void document.dispatchEvent(new Event("scroll")));
    log("rest at 97", { pinned: row.getAttribute("data-pinned") });
    expect(row.getAttribute("data-pinned")).toBe("false");
    place(row, 64, 62);
    act(() => void window.dispatchEvent(new Event("resize")));
    log("stuck at 64", { pinned: row.getAttribute("data-pinned") });
    expect(row.getAttribute("data-pinned")).toBe("true");
    // Its container scrolled out with it: above the line, no longer held there.
    place(row, -40, 62);
    act(() => void document.dispatchEvent(new Event("scroll")));
    log("scrolled out at -40", { pinned: row.getAttribute("data-pinned") });
    expect(row.getAttribute("data-pinned")).toBe("false");
  });
});

describe("LibraryCounts (PAR-LIB-06, UX-LIB-01)", () => {
  afterEach(cleanup);

  // @req PAR-LIB-06[parrot,parrot-web-player]
  // @req UX-LIB-01[badger-desktop,badger-web-player]
  it("reads as plain text with dots between, each number in the text colour", () => {
    render(
      <LibraryCounts
        counts={[
          { n: 14, text: "14 albums" },
          { n: 153, text: "153 songs" },
          { n: 2, text: "2 artists" },
        ]}
      />
    );
    const counts = screen.getByTestId("library-counts");
    const numbers = [...counts.querySelectorAll("em")].map((em) => em.textContent);
    log("counts", { text: counts.textContent, numbers });
    expect(counts.textContent).toBe("14 albums · 153 songs · 2 artists");
    expect(numbers).toEqual(["14", "153", "2"]);
    expect(counts.className).toContain("text-muted-foreground");
  });

  // @req UX-LIB-01[badger-desktop,badger-web-player]
  it("draws a filtered count, and words that do not hold the number as they are", () => {
    render(<LibraryCounts counts={[{ n: 12, text: "12 of 21 movies" }, { n: 0, text: "none" }]} />);
    const counts = screen.getByTestId("library-counts");
    log("filtered", { text: counts.textContent });
    expect(counts.textContent).toBe("12 of 21 movies · none");
    expect([...counts.querySelectorAll("em")].map((em) => em.textContent)).toEqual(["12"]);
  });
});

describe("LibraryRow (PAR-LIB-06, UX-LIB-01)", () => {
  afterEach(cleanup);

  const draw = (filters: number) =>
    render(
      <LibraryRow
        pinTop={64}
        logTag="library-row-test"
        counts={[
          { n: 24, text: "24 movies" },
          { n: 12, text: "12 shows" },
        ]}
        switcher={<LibrarySegmented ariaLabel="Library" value="movie" onChange={() => undefined} options={[{ id: "movie", label: "Movies" }, { id: "tv", label: "TV shows" }]} />}
        trailing={
          <>
            <LibraryFilterButton label="Filter" clearLabel="Clear" count={filters} onOpen={() => undefined} onClear={() => undefined} />
            <LibrarySortButton label="Sort" onOpen={() => undefined} />
          </>
        }
      />
    );

  // @req PAR-LIB-06[parrot,parrot-web-player]
  // @req UX-LIB-01[badger-desktop,badger-web-player]
  it("lays out switch, divider, counts, then the buttons pushed right, pinned at pinTop", () => {
    draw(0);
    const row = screen.getByTestId("library-row");
    const order = [...row.children].map((el) => el.getAttribute("data-testid"));
    log("row order", order);
    expect(order).toEqual(["library-toggle", "library-row-divider", "library-counts", "library-row-actions"]);
    expect(screen.getByTestId("library-row-actions").className).toContain("ml-auto");
    expect(screen.getByTestId("library-counts").textContent).toBe("24 movies · 12 shows");
    expect(screen.getByTestId("library-toolbar").style.top).toBe("64px");
    expect(screen.getByTestId("library-filter-button").textContent).toBe("Filter");
    expect(screen.queryByTestId("library-filter-clear")).toBeNull();
  });

  // @req PAR-LIB-06[parrot,parrot-web-player]
  // @req UX-LIB-01[badger-desktop,badger-web-player]
  it("badges the Filter button with the active filters and adds Clear; draws in theme colours only, so each app keeps its accent", () => {
    draw(2);
    const button = screen.getByTestId("library-filter-button");
    log("filtered button", { text: button.textContent, className: button.className });
    expect(button.textContent).toBe("Filter · 2");
    expect(button.className).toContain("bg-primary");
    expect(screen.getByTestId("library-filter-clear").textContent).toBe("Clear");
    expect(screen.getByTestId("library-toolbar").outerHTML).not.toMatch(/#[0-9a-f]{6}\b/i);
  });

  // @req PAR-LIB-06[parrot,parrot-web-player]
  // @req UX-LIB-01[badger-desktop,badger-web-player]
  it("the switch is a tab list: only the open tab is in the Tab order, arrows / Home / End move to the next tab", () => {
    function Switch() {
      const [tab, setTab] = useState("albums");
      return <LibrarySegmented ariaLabel="Library" value={tab} onChange={setTab} options={["albums", "artists", "songs"].map((id) => ({ id, label: id }))} />;
    }
    render(<Switch />);
    const state = () => screen.getAllByRole("tab").map((el) => `${el.textContent}:${el.getAttribute("aria-selected")}:${el.tabIndex}`);
    expect(state()).toEqual(["albums:true:0", "artists:false:-1", "songs:false:-1"]);
    const list = screen.getByRole("tablist");
    act(() => void fireEvent.keyDown(list, { key: "ArrowLeft" }));
    log("after ArrowLeft", state());
    expect(state()[2]).toBe("songs:true:0");
    expect(document.activeElement?.textContent).toBe("songs");
    act(() => void fireEvent.keyDown(list, { key: "ArrowRight" }));
    expect(state()[0]).toBe("albums:true:0");
    act(() => void fireEvent.keyDown(list, { key: "End" }));
    expect(state()[2]).toBe("songs:true:0");
    act(() => void fireEvent.keyDown(list, { key: "Home" }));
    expect(state()[0]).toBe("albums:true:0");
  });

  // @req UX-LIB-01[badger-desktop,badger-web-player]
  it("an action pill (Badger's sort direction) is a plain button, not a toggle", () => {
    render(<LibraryPills pills={[{ id: "pick", label: "Title", on: true, onClick: () => undefined }, { id: "direction", label: "Ascending", onClick: () => undefined }]} />);
    const [pick, direction] = screen.getAllByRole("button");
    expect(pick?.getAttribute("aria-pressed")).toBe("true");
    expect(direction?.hasAttribute("aria-pressed")).toBe(false);
  });
});

describe("The Filter panel and its lists (UX-LIB-01, UX-LIB-03)", () => {
  afterEach(() => cleanup());

  // @req UX-LIB-01[badger-desktop,badger-web-player]
  it("a long list's \"+N more\" chip is a focusable button that shows the rest in place and hands the focus to the first chip it revealed", () => {
    const options = Array.from({ length: FILTER_CHIP_LIMIT + 10 }, (_, index) => ({ value: `v${index}`, label: `Actor ${index}` }));
    render(<BadgerFilterPicker searchPlaceholder="Search actors" emptyText="None" moreLabel={(n) => `+${n} more`} options={options} selected={[]} onChange={() => undefined} />);
    const more = screen.getByTestId("library-filter-more");
    log("more chip", { tag: more.tagName, text: more.textContent, chips: screen.getAllByRole("button").length });
    expect(more.tagName).toBe("BUTTON");
    expect(more.textContent).toBe("+10 more");
    more.focus();
    expect(document.activeElement).toBe(more);
    act(() => void fireEvent.click(more));
    const chips = screen.getAllByRole("button");
    log("expanded", { chips: chips.length });
    expect(chips).toHaveLength(FILTER_CHIP_LIMIT + 10);
    expect(screen.queryByTestId("library-filter-more")).toBeNull();
    expect(screen.getByText(`Actor ${FILTER_CHIP_LIMIT + 9}`)).toBeTruthy();
    // The pressed chip is gone: the focus lands on the first chip it revealed, not on the panel.
    log("focus after more", { focused: document.activeElement?.textContent });
    expect(document.activeElement?.textContent).toBe(`Actor ${FILTER_CHIP_LIMIT}`);
  });

  // @req UX-LIB-01[badger-desktop,badger-web-player]
  // @req PAR-LIB-06[parrot,parrot-web-player]
  it("shows a fade and a line over the buttons only while more of the panel body sits below", () => {
    render(
      <LibraryModal open onOpenChange={() => undefined} title="Filter" closeLabel="Close" footer={<button type="button">Apply</button>} testId="library-filter-panel">
        <div>lists</div>
      </LibraryModal>
    );
    const body = screen.getByTestId("library-filter-panel-body");
    // The panel takes the focus on open (so it opens at its top) and draws no outline of its own.
    expect(screen.getByTestId("library-filter-panel").className).toContain("outline-none");
    expect(screen.queryByTestId("library-filter-panel-fade")).toBeNull();
    // jsdom lays nothing out: the body is given a 200px window onto 500px of lists.
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(body, "scrollHeight", { configurable: true, value: 500 });
    act(() => void body.dispatchEvent(new Event("scroll")));
    const footer = screen.getByText("Apply").parentElement;
    log("overflowing", { fade: Boolean(screen.queryByTestId("library-filter-panel-fade")), footer: footer?.className });
    expect(screen.queryByTestId("library-filter-panel-fade")).not.toBeNull();
    expect(footer?.className).toContain("border-t");
    body.scrollTop = 300;
    act(() => void body.dispatchEvent(new Event("scroll")));
    log("scrolled to the end", { fade: Boolean(screen.queryByTestId("library-filter-panel-fade")) });
    expect(screen.queryByTestId("library-filter-panel-fade")).toBeNull();
    expect(footer?.className).not.toContain("border-t");
  });
});
