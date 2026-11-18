/**
 * @req LIB-LANG-02
 * @test-id DESKTOP-DETAILS-LIBRARY-001..002
 * @level unit
 * @bugfix details-re-asked-while-browsing
 *
 * Why: browsing the desktop library re-asked the metadata service for a title's full details answer on every app
 * start: the Library page re-fetched every title with no genre on mount, the detail dialog did it again on open, and
 * the synopsis and episode overlays fetched the same answer twice per show. Genres now come at import and refresh
 * only, and the overlays read the texts kept in the library (`createDetailsTexts` with the desktop's library),
 * asking the service only when no device kept them yet.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LOG = "[details-from-library]";
const SRC = resolve(__dirname, "../src/renderer/src");
const read = (path: string) => readFileSync(resolve(SRC, path), "utf8");

describe("desktop browsing asks no details lookup (LIB-LANG-02)", () => {
  it("DESKTOP-DETAILS-LIBRARY-001: the Library page and the detail dialog never fetch details for genres", () => {
    const library = read("pages/Library.tsx");
    const libraryCalls = library.match(/getTitleDetails\s*\(/g) ?? [];
    console.info(`${LOG} pages/Library.tsx: getTitleDetails calls=${libraryCalls.length}`);
    expect(libraryCalls).toEqual([]);
    // The dialog never asks a title's details itself: not to fill genres on open, and not for its trailers after a
    // trailer-language change (the original language comes from the library row, else the kept texts:
    // `trailerOriginalLanguage`, tests/trailer-original-language.test.ts).
    const dialog = read("components/MediaDetailsDialog.tsx");
    const dialogCalls = dialog.match(/getTitleDetails\s*\(/g) ?? [];
    console.info(`${LOG} components/MediaDetailsDialog.tsx: getTitleDetails calls=${dialogCalls.length}`);
    expect(dialogCalls).toEqual([]);
    expect(/trailerOriginalLanguage\(/.test(dialog)).toBe(true);
  });

  it("DESKTOP-DETAILS-LIBRARY-002: the synopsis and episode overlays read the texts kept in the library", () => {
    const metadata = read("lib/metadata.ts");
    const usesLibrary = /createDetailsTexts\(/.test(metadata) && /getSetting\(/.test(metadata) && /setSetting\(/.test(metadata);
    console.info(`${LOG} lib/metadata.ts: library-backed texts=${usesLibrary}`);
    expect(usesLibrary).toBe(true);
    for (const hook of ["lib/useLocalizedOverview.ts", "lib/useLocalizedEpisodes.ts"]) {
      const source = read(hook);
      const direct = /getMetadataDetails|getTitleDetails/.test(source);
      console.info(`${LOG} ${hook}: direct details call=${direct}`);
      expect(direct).toBe(false);
    }
  });
});
