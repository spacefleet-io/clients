import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The Library page is the design's slim row over a 7-column grid, built from the shared @space/ui/badger pieces
// (the shared pieces' rendering is covered by packages/ui/tests/badger-home-library.test.tsx).
const library = readFileSync(resolve(process.cwd(), "src/renderer/src/pages/Library.tsx"), "utf8");
const LOG = "[library-row-source]";

describe("desktop Library page layout", () => {
  /** @req UX-LIB-01[badger-desktop] */
  it("has one slim row (toggle, search, then Filter / Sort / view cycle) and no title, stats, Add button or floating +", () => {
    const row = library.slice(library.indexOf("<BadgerLibraryRow"), library.indexOf("/>\n\n            {loading ?"));
    const order = ["<BadgerSegmented", "<BadgerSearchField", "<BadgerLibraryControls"].map((needle) => row.indexOf(needle));
    console.info(`${LOG} row length=${row.length} order=${JSON.stringify(order)}`);
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
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
