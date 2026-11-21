import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The Library page is the design's slim row over a 7-column grid, built from the shared @space/ui pieces (the row's
// rendering is covered by packages/ui/tests/library-row.test.tsx and library-toolbar.test.tsx).
const library = readFileSync(resolve(process.cwd(), "src/renderer/src/pages/Library.tsx"), "utf8");
const LOG = "[library-row-source]";

describe("desktop Library page layout", () => {
  /** @req UX-LIB-01[badger-desktop] */
  it("has the shared slim row (toggle and both counts, then Filter / Sort / view cycle), pinned, with no title, search box, Add button or floating +", () => {
    const row = library.slice(library.indexOf("<LibraryRow"), library.indexOf('{libraryState === "loading"'));
    const order = ["counts={libraryStats}", "<LibrarySegmented", "<BadgerLibraryControls"].map((needle) => row.indexOf(needle));
    console.info(`${LOG} row length=${row.length} order=${JSON.stringify(order)}`);
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Chris 2026-11-20: the row pins under the 64 px top bar, shows the quiet counts and has no search box (Ctrl/Cmd+K
    // finds titles); the follow-up gave it Parrot's design, the shared LibraryRow.
    expect(row).toContain("pinTop={64}");
    expect(library).toContain('t("library.stats.movie"');
    expect(library).toContain('t("library.stats.tv"');
    expect(library).not.toContain("BadgerSearchField");
    expect(library).toContain('t("library.stats.shownOf"');
    expect(library).not.toContain('t("library.addMedia")');
    expect(library).not.toContain("showFab");
    expect(library).not.toContain("<header");
    expect(library).not.toContain("<CardContent");
  });

  /** @req UX-LIB-02[badger-desktop] */
  it("lays titles out in the shared 7-column poster grid with the watched tick and progress line", () => {
    const grid = library.slice(library.indexOf("const renderGrid"), library.indexOf("const renderListSection"));
    console.info(`${LOG} grid uses BadgerPosterGrid=${grid.includes("<BadgerPosterGrid")} cards=${grid.split("<BadgerPosterCard").length - 1}`);
    expect(grid).toContain("<BadgerPosterGrid");
    expect(grid).toContain("<BadgerPosterCard");
    expect(grid).toContain('watched={progressBand === "watched"}');
    expect(grid).toMatch(/progressPct=\{progressBand === "in-progress" \? getVisibleProgressPct/);
    expect(grid).not.toMatch(/w-\[210px\]/);
  });
});
